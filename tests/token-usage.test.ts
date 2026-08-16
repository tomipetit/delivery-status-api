import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { TokenUsageRecord } from "../src/ai/terra.ts";
import {
  sendUsageReport,
  usageReportMessage,
  type UsageReportEnv,
} from "../src/notify/usage-report.ts";
import { DEFAULT_PRICING, estimateCostUsd, pricingFromVars } from "../src/pricing.ts";
import { recordTokenUsage, type TokenUsageSummary } from "../src/storage/token-usage.ts";
import { tokyoPreviousCalendarDate } from "../src/tokyo-day.ts";
import { createInMemoryD1 } from "./helpers/in-memory-d1.ts";

function usageRecord(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    operation: "yamato-extract",
    model: "gpt-5.6-terra",
    inputTokens: 1000,
    cachedTokens: 200,
    outputTokens: 300,
    reasoningTokens: 150,
    totalTokens: 1300,
    usageReported: true,
    ...overrides,
  };
}

function summary(overrides: Partial<TokenUsageSummary> = {}): TokenUsageSummary {
  return {
    tokyoDate: "2026-08-15",
    byOperation: [{
      operation: "yamato-extract",
      model: "gpt-5.6-terra",
      calls: 1,
      inputTokens: 1000,
      cachedTokens: 200,
      outputTokens: 300,
      reasoningTokens: 150,
      totalTokens: 1300,
    }],
    calls: 1,
    totalTokens: 1300,
    unreportedCalls: 0,
    ...overrides,
  };
}

const healthy = { failures: [] as const, abortMessage: null };
const month = {
  calls: 4,
  totalTokens: 5200,
  inputTokens: 4000,
  cachedTokens: 800,
  outputTokens: 1200,
};
const pricing = { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 };

test("cost charges cached input at its own rate and never bills reasoning twice", () => {
  // reasoning_tokens is a component of output_tokens, and cached_tokens a
  // component of input_tokens, so 1,000 input / 200 cached / 300 output is
  // 800 uncached input + 200 cached + 300 output.
  const expected = (800 * 2 + 200 * 0.2 + 300 * 12) / 1_000_000;
  assert.equal(
    estimateCostUsd({ inputTokens: 1000, cachedTokens: 200, outputTokens: 300 }, pricing),
    expected,
  );

  // The reported row carries reasoningTokens too. The cost printed for it must
  // match the input/cached/output-only figure: reasoning is already inside
  // outputTokens, so counting it again would inflate every reasoning-heavy day.
  const row = {
    operation: "yamato-extract",
    model: "gpt-5.6-terra",
    calls: 1,
    inputTokens: 1000,
    cachedTokens: 200,
    outputTokens: 300,
    reasoningTokens: 290,
    totalTokens: 1300,
  };
  const message = usageReportMessage({
    summary: summary({ byOperation: [row] }),
    month,
    pricing,
    ...healthy,
  });
  assert.ok(
    message.includes(`$${expected.toFixed(5)}`),
    `expected $${expected.toFixed(5)} in the report`,
  );
});

test("a fully cached prompt costs only the cached rate", () => {
  assert.equal(
    estimateCostUsd({ inputTokens: 1000, cachedTokens: 1000, outputTokens: 0 }, pricing),
    1000 * 0.2 / 1_000_000,
  );
});

test("pricing falls back to the published rates when a var is unset or unusable", () => {
  assert.deepEqual(pricingFromVars({}), DEFAULT_PRICING);
  assert.deepEqual(
    pricingFromVars({ OPENAI_PRICE_INPUT_USD_PER_MTOK: "  " }),
    DEFAULT_PRICING,
  );
  // A bad value must not silently become zero, which would read as "free".
  assert.equal(
    pricingFromVars({ OPENAI_PRICE_OUTPUT_USD_PER_MTOK: "twelve" }).outputPerMillion,
    DEFAULT_PRICING.outputPerMillion,
  );
  assert.equal(
    pricingFromVars({ OPENAI_PRICE_OUTPUT_USD_PER_MTOK: "-3" }).outputPerMillion,
    DEFAULT_PRICING.outputPerMillion,
  );
  assert.equal(
    pricingFromVars({ OPENAI_PRICE_INPUT_USD_PER_MTOK: "1.75" }).inputPerMillion,
    1.75,
  );
});

test("the report shows the estimated cost and the rates it used", () => {
  const message = usageReportMessage({ summary: summary(), month, pricing, ...healthy });

  // 800 * 2 + 200 * 0.2 + 300 * 12 = 5,240 per million = $0.00524
  assert.match(message, /推定 \*\$0\.00524\*/);
  assert.match(message, /input \$2 \/ cached \$0\.2 \/ output \$12 per 1M tokens/);
  assert.match(message, /reasoning は output に含まれるため二重計上していません/);
});

test("a zero-token day reports no cost rather than a blank", () => {
  const message = usageReportMessage({
    summary: summary({ byOperation: [], calls: 0, totalTokens: 0 }),
    month: { calls: 0, totalTokens: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
    pricing,
    ...healthy,
  });

  assert.match(message, /合計 \*0\* トークン \/ 0 回の呼び出し — 推定 \*\$0\*/);
});

test("token usage migration adds only its own table and lookup index", async () => {
  const migration = await readFile(
    new URL("migrations/0005_token_usage.sql", `file://${process.cwd()}/`),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS token_usage/);
  for (const column of [
    "occurred_at", "tokyo_date", "operation", "model",
    "input_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "total_tokens",
    "usage_reported",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  // The daily report groups by the Tokyo calendar day, so that column is indexed.
  assert.match(migration, /CREATE INDEX IF NOT EXISTS \w+ ON token_usage\(tokyo_date\)/);

  // Additive only: nothing already stored may be rewritten.
  assert.doesNotMatch(migration, /ALTER TABLE/i);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /delivery_restrictions|carrier_source_|api_keys|postal_codes/);
});

test("tokyoPreviousCalendarDate steps back one Tokyo day across a month boundary", () => {
  // 2026-09-01T00:30+09:00 is still 2026-08-31T15:30Z.
  assert.equal(tokyoPreviousCalendarDate(new Date("2026-08-31T15:30:00Z")), "2026-08-31");
  assert.equal(tokyoPreviousCalendarDate(new Date("2026-09-01T05:00:00Z")), "2026-08-31");
  assert.equal(tokyoPreviousCalendarDate(new Date("2026-01-01T00:00:00+09:00")), "2025-12-31");
});

test("recordTokenUsage writes one row per call, stamped with the Tokyo day", async () => {
  const memory = createInMemoryD1({});
  const now = new Date("2026-08-15T15:30:00Z"); // 2026-08-16 00:30 JST

  await recordTokenUsage(memory.db, [
    usageRecord(),
    usageRecord({ operation: "japan_post-pdf-extract", usageReported: false, totalTokens: 0 }),
  ], now);

  assert.equal(memory.batches.length, 1, "a partially written run must not leave the total short");
  const [batch] = memory.batches;
  assert.equal(batch.length, 2);
  for (const statement of batch) {
    assert.match(statement.sql, /INSERT INTO token_usage/);
    assert.equal(statement.values[1], "2026-08-16", "the Tokyo day, not the UTC one");
  }
  assert.equal(batch[0].values[9], 1, "usage_reported");
  assert.equal(batch[1].values[9], 0, "a billed call with no usage block is still recorded");
});

test("recordTokenUsage writes nothing when no call was billed", async () => {
  const memory = createInMemoryD1({});
  await recordTokenUsage(memory.db, [], new Date());
  assert.equal(memory.batches.length, 0);
});

test("the report states the day's total, the breakdown, and the month to date", () => {
  const message = usageReportMessage({ summary: summary(), month, pricing, ...healthy });

  assert.match(message, /\*\[delivery-status-api\] 2026-08-15 \(JST\) トークン使用量\*/);
  assert.match(message, /合計 \*1,300\* トークン \/ 1 回の呼び出し/);
  assert.match(message, /今月累計 5,200 トークン \/ 4 回/);
  assert.match(message, /yamato-extract/);
  assert.match(message, /gpt-5\.6-terra/);
});

test("the breakdown is a closed code block so Chat keeps the columns aligned", () => {
  const message = usageReportMessage({
    summary: summary({
      byOperation: [
        {
          operation: "yamato-extract",
          model: "gpt-5.6-terra",
          calls: 1,
          inputTokens: 1000,
          cachedTokens: 200,
          outputTokens: 300,
          reasoningTokens: 150,
          totalTokens: 1300,
        },
        {
          operation: "japan_post-pdf-extract",
          model: "gpt-5.6-terra",
          calls: 2,
          inputTokens: 40000,
          cachedTokens: 0,
          outputTokens: 900,
          reasoningTokens: 400,
          totalTokens: 40900,
        },
      ],
      calls: 3,
      totalTokens: 42200,
    }),
    month,
    pricing,
    ...healthy,
  });

  const fences = message.match(/^```$/gm) ?? [];
  assert.equal(fences.length, 2, "the block must be opened and closed exactly once");

  const [header, first, second] = message.split("\n").filter((line) => /\s{2}/.test(line));
  // Every row is padded to the same width, so the columns line up in a monospace block.
  assert.equal(first.length, header.length);
  assert.equal(second.length, header.length);
});

test("a zero-token day is still reported, and says why it was zero", () => {
  const message = usageReportMessage({
    summary: summary({ byOperation: [], calls: 0, totalTokens: 0 }),
    month,
    pricing,
    ...healthy,
  });

  assert.match(message, /合計 \*0\* トークン/);
  assert.match(message, /モデル呼び出しはありませんでした/);
  assert.doesNotMatch(message, /```/, "an empty day needs no table");
});

test("calls the API billed without a usage block are called out, not silently dropped", () => {
  const message = usageReportMessage({ summary: summary({ unreportedCalls: 2 }), month, pricing, ...healthy });
  assert.match(message, /2 件は API が usage を返さず/);
});

test("a failed sync marks the heading and lists the per-carrier failures", () => {
  const message = usageReportMessage({
    summary: summary(),
    month,
    pricing,
    failures: [{ carrier: "sagawa" as const, phase: "extract" as const, message: "boom" }],
    abortMessage: null,
  });

  assert.match(message, /⚠️ 同期失敗 /);
  assert.match(message, /• sagawa \[extract\] boom/);
});

test("a run that aborted outside a carrier is reported as an abort", () => {
  const message = usageReportMessage({
    summary: summary(),
    month,
    pricing,
    failures: [],
    abortMessage: "DB unreachable",
  });

  assert.match(message, /⚠️ 同期失敗 /);
  assert.match(message, /同期が異常終了しました:\* DB unreachable/);
});

test("a backtick in a failure message cannot break out of the code block", () => {
  const message = usageReportMessage({
    summary: summary(),
    month,
    pricing,
    failures: [{ carrier: "sagawa" as const, phase: "extract" as const, message: "bad ``` input" }],
    abortMessage: null,
  });

  // The two fences are the breakdown table's own; nothing else opens one.
  assert.equal((message.match(/^```$/gm) ?? []).length, 2);
  assert.match(message, /bad ''' input/);
});

test("an unconfigured webhook skips the post instead of failing the run", async () => {
  const env = {
    DB: createInMemoryD1({}).db,
    GOOGLE_CHAT_WEBHOOK_URL: "",
  } satisfies UsageReportEnv;

  // Any fetch here would be a bug: the guard must return before the summary query.
  await sendUsageReport(env, "2026-08-15", { failures: [], abortMessage: null });
});
