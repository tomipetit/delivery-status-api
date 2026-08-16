import { tokyoCalendarDate } from "../tokyo-day";
import type { TokenUsageRecord } from "../ai/terra";

export interface TokenUsageOperationTotal {
  operation: string;
  model: string;
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TokenUsageSummary {
  tokyoDate: string;
  byOperation: TokenUsageOperationTotal[];
  calls: number;
  totalTokens: number;
  /** Calls the API billed but reported no usage block for. */
  unreportedCalls: number;
}

/**
 * Persists a run's usage. Written as one batch so a partially recorded run
 * cannot leave the daily total silently short.
 */
export async function recordTokenUsage(
  db: D1Database,
  records: readonly TokenUsageRecord[],
  now: Date,
): Promise<void> {
  if (records.length === 0) return;

  const occurredAt = now.toISOString();
  const tokyoDate = tokyoCalendarDate(now);

  await db.batch(records.map((record) => db.prepare(`
    INSERT INTO token_usage (
      occurred_at, tokyo_date, operation, model,
      input_tokens, cached_tokens, output_tokens, reasoning_tokens, total_tokens,
      usage_reported
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    occurredAt,
    tokyoDate,
    record.operation,
    record.model,
    record.inputTokens,
    record.cachedTokens,
    record.outputTokens,
    record.reasoningTokens,
    record.totalTokens,
    record.usageReported ? 1 : 0,
  )));
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function summarizeTokenUsage(
  db: D1Database,
  tokyoDate: string,
): Promise<TokenUsageSummary> {
  const { results } = await db.prepare(`
    SELECT operation, model,
           COUNT(*) AS calls,
           SUM(input_tokens) AS input_tokens,
           SUM(cached_tokens) AS cached_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(reasoning_tokens) AS reasoning_tokens,
           SUM(total_tokens) AS total_tokens,
           SUM(CASE WHEN usage_reported = 0 THEN 1 ELSE 0 END) AS unreported
    FROM token_usage
    WHERE tokyo_date = ?
    GROUP BY operation, model
    ORDER BY total_tokens DESC, operation ASC
  `).bind(tokyoDate).all<Record<string, unknown>>();

  const byOperation: TokenUsageOperationTotal[] = (results ?? []).map((row) => ({
    operation: String(row.operation),
    model: String(row.model),
    calls: toNumber(row.calls),
    inputTokens: toNumber(row.input_tokens),
    cachedTokens: toNumber(row.cached_tokens),
    outputTokens: toNumber(row.output_tokens),
    reasoningTokens: toNumber(row.reasoning_tokens),
    totalTokens: toNumber(row.total_tokens),
  }));

  return {
    tokyoDate,
    byOperation,
    calls: byOperation.reduce((sum, row) => sum + row.calls, 0),
    totalTokens: byOperation.reduce((sum, row) => sum + row.totalTokens, 0),
    unreportedCalls: (results ?? []).reduce((sum, row) => sum + toNumber(row.unreported), 0),
  };
}

export interface TokenUsageMonthTotal {
  calls: number;
  totalTokens: number;
  /** Carried so the month's cost is estimated from the same split as the day's. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** Month-to-date total, so the daily report shows the trend and not just one day. */
export async function sumTokenUsageForMonth(
  db: D1Database,
  tokyoDate: string,
): Promise<TokenUsageMonthTotal> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(input_tokens) AS input_tokens,
           SUM(cached_tokens) AS cached_tokens,
           SUM(output_tokens) AS output_tokens
    FROM token_usage
    WHERE tokyo_date LIKE ?
  `).bind(`${tokyoDate.slice(0, 7)}-%`).first<Record<string, unknown>>();

  return {
    calls: toNumber(row?.calls),
    totalTokens: toNumber(row?.total_tokens),
    inputTokens: toNumber(row?.input_tokens),
    cachedTokens: toNumber(row?.cached_tokens),
    outputTokens: toNumber(row?.output_tokens),
  };
}
