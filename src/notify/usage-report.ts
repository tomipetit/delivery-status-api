import {
  estimateCostUsd,
  formatUsd,
  pricingFromVars,
  type ModelPricing,
  type PricingVars,
} from "../pricing";
import {
  summarizeTokenUsage,
  sumTokenUsageForMonth,
  type TokenUsageMonthTotal,
  type TokenUsageSummary,
} from "../storage/token-usage";
import type { CarrierSyncFailure } from "../sync";

export interface UsageReportEnv extends PricingVars {
  DB: D1Database;
  /**
   * Google Chat incoming webhook. Carries `key` and `token` query parameters,
   * so it is a secret rather than a var: anyone holding the URL can post to the
   * space.
   */
  GOOGLE_CHAT_WEBHOOK_URL: string;
}

const REPORT_NAME = "delivery-status-api";

/** How the sync that ran alongside this report ended. */
export interface SyncOutcome {
  failures: readonly CarrierSyncFailure[];
  /** Set when the run threw something other than a per-carrier SyncError. */
  abortMessage: string | null;
}

interface ReportInput extends SyncOutcome {
  summary: TokenUsageSummary;
  month: TokenUsageMonthTotal;
  pricing: ModelPricing;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function isHealthy({ failures, abortMessage }: SyncOutcome): boolean {
  return failures.length === 0 && abortMessage === null;
}

/**
 * Chat renders ``` fences, so a backtick inside interpolated text would close
 * the block early and scramble the rest of the message.
 */
function fenceSafe(value: string): string {
  return value.replace(/`/g, "'");
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function breakdownTable(summary: TokenUsageSummary, pricing: ModelPricing): string {
  const header = ["operation", "model", "calls", "input", "cached", "output", "reasoning", "total", "cost"];
  const rows = summary.byOperation.map((row) => [
    fenceSafe(row.operation),
    fenceSafe(row.model),
    formatNumber(row.calls),
    formatNumber(row.inputTokens),
    formatNumber(row.cachedTokens),
    formatNumber(row.outputTokens),
    formatNumber(row.reasoningTokens),
    formatNumber(row.totalTokens),
    formatUsd(estimateCostUsd(row, pricing)),
  ]);

  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length)));
  // Only the two leading label columns read left-aligned; the counts line up right.
  const line = (cells: string[]): string => cells
    .map((cell, column) => (column < 2 ? padEnd(cell, widths[column]) : padStart(cell, widths[column])))
    .join("  ")
    .trimEnd();

  return ["```", line(header), ...rows.map(line), "```"].join("\n");
}

/** The day's billed tokens, summed from the per-operation rows. */
function dayTokens(summary: TokenUsageSummary) {
  return summary.byOperation.reduce(
    (total, row) => ({
      inputTokens: total.inputTokens + row.inputTokens,
      cachedTokens: total.cachedTokens + row.cachedTokens,
      outputTokens: total.outputTokens + row.outputTokens,
    }),
    { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
  );
}

export function usageReportMessage(input: ReportInput): string {
  const { summary, month, pricing, failures } = input;
  const status = isHealthy(input) ? "" : "⚠️ 同期失敗 ";
  const dayCost = estimateCostUsd(dayTokens(summary), pricing);
  const monthCost = estimateCostUsd(month, pricing);
  const lines = [
    `*[${REPORT_NAME}] ${status}${summary.tokyoDate} (JST) トークン使用量*`,
    "",
    `合計 *${formatNumber(summary.totalTokens)}* トークン / ${formatNumber(summary.calls)} 回の呼び出し`
      + ` — 推定 *${formatUsd(dayCost)}*`,
    `今月累計 ${formatNumber(month.totalTokens)} トークン / ${formatNumber(month.calls)} 回`
      + ` — 推定 ${formatUsd(monthCost)}`,
    "",
  ];

  lines.push(summary.byOperation.length === 0
    ? "モデル呼び出しはありませんでした（全ソースが無変更でスキップ）。"
    : breakdownTable(summary, pricing));

  if (summary.unreportedCalls > 0) {
    lines.push(
      "",
      `注意: ${formatNumber(summary.unreportedCalls)} 件は API が usage を返さず、`
        + "課金はされていますが上記の合計と推定コストには含まれていません。",
    );
  }

  // The rates are printed so the figure can be checked against the invoice, and
  // so a stale var is visible in the report rather than only in the config.
  lines.push(
    "",
    `_推定コストは input $${pricing.inputPerMillion} / cached $${pricing.cachedInputPerMillion}`
      + ` / output $${pricing.outputPerMillion} per 1M tokens で計算。`
      + "reasoning は output に含まれるため二重計上していません。実際の請求額は OpenAI の明細が正です。_",
  );

  if (input.abortMessage !== null) {
    lines.push("", `*同期が異常終了しました:* ${fenceSafe(input.abortMessage)}`);
  }

  if (failures.length > 0) {
    lines.push("", "*同期の失敗:*");
    for (const failure of failures) {
      lines.push(`• ${failure.carrier} [${failure.phase}] ${fenceSafe(failure.message)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Builds and posts the daily report to Google Chat.
 *
 * Deliberately posted even on a zero-token day: a message that stops arriving
 * is the signal that the cron itself died, which a "only notify when something
 * happened" rule would hide.
 */
export async function sendUsageReport(
  env: UsageReportEnv,
  tokyoDate: string,
  outcome: SyncOutcome,
): Promise<void> {
  if (!env.GOOGLE_CHAT_WEBHOOK_URL) {
    console.warn("[usage-report] GOOGLE_CHAT_WEBHOOK_URL not configured; skipping");
    return;
  }

  const summary = await summarizeTokenUsage(env.DB, tokyoDate);
  const month = await sumTokenUsageForMonth(env.DB, tokyoDate);
  const text = usageReportMessage({
    summary,
    month,
    pricing: pricingFromVars(env),
    ...outcome,
  });

  const response = await fetch(env.GOOGLE_CHAT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    // The URL carries credentials in its query string, so it is never logged.
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Google Chat webhook returned ${response.status}: ${detail}`);
  }

  console.info(
    `[usage-report] posted ${tokyoDate}: calls=${summary.calls} total=${summary.totalTokens}`,
  );
}
