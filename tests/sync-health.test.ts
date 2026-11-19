import assert from "node:assert/strict";
import test from "node:test";

import { EXTRACTOR_VERSION } from "../src/ai/terra.ts";
import {
  carrierFreshness,
  formatTokyoDateTime,
  staleCarrierWarnings,
} from "../src/freshness.ts";
import { usageReportMessage } from "../src/notify/usage-report.ts";
import { listCarrierLastCheckedAt } from "../src/storage/source-states.ts";
import { countChangeWarnings, syncAll, type CarrierSyncWarning } from "../src/sync.ts";
import { createInMemoryD1, sourceState } from "./helpers/in-memory-d1.ts";

const model = "test-model";
const yamatoUrl = "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html";

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = { info: console.info, warn: console.warn, error: console.error };
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    Object.assign(console, original);
  }
}

test("countChangeWarnings flags a carrier that fell to zero", () => {
  const warnings = countChangeWarnings(
    { yamato: 21, sagawa: 2, japan_post: 0 },
    { yamato: 0, sagawa: 2, japan_post: 0 },
  );
  assert.deepEqual(warnings.map(({ carrier, kind }) => ({ carrier, kind })), [
    { carrier: "yamato", kind: "count-zeroed" },
  ]);
  assert.match(warnings[0].message, /前回 21件/);
});

test("countChangeWarnings flags a drop to half or less only from four records upward", () => {
  const warnings = countChangeWarnings(
    { yamato: 21, sagawa: 3, japan_post: 4 },
    { yamato: 10, sagawa: 1, japan_post: 3 },
  );
  assert.deepEqual(warnings.map(({ carrier, kind }) => ({ carrier, kind })), [
    { carrier: "yamato", kind: "count-dropped" },
  ]);
  assert.match(warnings[0].message, /21件 → 10件/);
});

test("countChangeWarnings stays quiet for growth, small changes, and an already-empty carrier", () => {
  assert.deepEqual(
    countChangeWarnings(
      { yamato: 21, sagawa: 0, japan_post: 5 },
      { yamato: 30, sagawa: 0, japan_post: 3 },
    ),
    [],
  );
});

test("staleCarrierWarnings flags a carrier unchecked for 36 hours or never checked", () => {
  const now = new Date("2026-11-21T00:00:30Z");
  const warnings = staleCarrierWarnings(carrierFreshness({
    yamato: "2026-11-19T00:00:10Z",
    sagawa: "2026-11-20T00:00:40Z",
  }), now);

  assert.deepEqual(warnings.map(({ carrier, kind }) => ({ carrier, kind })), [
    { carrier: "yamato", kind: "stale" },
    { carrier: "japan_post", kind: "stale" },
  ]);
  assert.match(warnings[0].message, /11\/19 09:00（約2日前）/);
  assert.match(warnings[1].message, /一度も確認できていません/);
});

test("formatTokyoDateTime prints Tokyo time across the date line", () => {
  assert.equal(formatTokyoDateTime("2026-11-18T15:05:00Z"), "11/19 00:05");
});

test("listCarrierLastCheckedAt reads every stored carrier", async () => {
  const memory = createInMemoryD1({
    states: {
      yamato: sourceState("yamato", "fp", "2026-11-19T00:00:00.000Z"),
      sagawa: sourceState("sagawa", "fp", "2026-11-18T00:00:00.000Z"),
    },
  });
  assert.deepEqual(await listCarrierLastCheckedAt(memory.db), {
    yamato: "2026-11-19T00:00:00.000Z",
    sagawa: "2026-11-18T00:00:00.000Z",
  });
});

test("a Yamato extraction of zero records keeps the data and leaves a warning", async () => {
  const checkedAt = new Date().toISOString();
  const memory = createInMemoryD1({
    counts: { yamato: 21 },
    states: {
      sagawa: sourceState("sagawa", `sagawa:xml-v1:rules=${EXTRACTOR_VERSION}:model=${model}:skip`, checkedAt),
      japan_post: sourceState("japan_post", `japan-post:pdf-v1:rules=${EXTRACTOR_VERSION}:model=${model}:pdfsha=skip`, checkedAt),
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === yamatoUrl) {
      return new Response([
        "<p>●下記地域のお荷物について、荷受けを停止しております</p>",
        "<table><tr><td>石川県</td><td>輪島市</td><td>宅急便</td></tr></table>",
      ].join(""));
    }
    if (url === "https://api.openai.com/v1/responses") {
      return Response.json({ status: "completed", output_text: "[]" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const warnings: CarrierSyncWarning[] = [];
    const counts = await quiet(() => syncAll({ DB: memory.db, OPENAI_API_KEY: "k", OPENAI_MODEL: model }, warnings));

    assert.equal(counts.yamato, 21);
    assert.deepEqual(warnings.map(({ carrier, kind }) => ({ carrier, kind })), [
      { carrier: "yamato", kind: "zero-extracted" },
    ]);
    assert.match(warnings[0].message, /既存のデータ（21件）を残しました/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const reportBase = {
  summary: {
    tokyoDate: "2026-11-18",
    byOperation: [],
    calls: 0,
    totalTokens: 0,
    unreportedCalls: 0,
  },
  month: { calls: 0, totalTokens: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
  pricing: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
  failures: [] as const,
  abortMessage: null,
};

test("the report marks warnings in its title and lists them", () => {
  const message = usageReportMessage({
    ...reportBase,
    warnings: [{ carrier: "yamato", kind: "count-zeroed", message: "件数が0件になりました（前回 21件）。" }],
  });
  assert.match(message, /⚠️ 要確認 2026-11-18/);
  assert.match(message, /\*要確認:\*\n• yamato 件数が0件になりました（前回 21件）。/);
});

test("the report keeps the failure title when there are failures and warnings", () => {
  const message = usageReportMessage({
    ...reportBase,
    failures: [{ carrier: "sagawa", phase: "fetch", message: "boom" }],
    warnings: [{ carrier: "yamato", kind: "stale", message: "古い" }],
  });
  assert.match(message, /⚠️ 同期失敗 2026-11-18/);
  assert.match(message, /\*要確認:\*/);
});

test("the report prints when each carrier was last checked", () => {
  const message = usageReportMessage({
    ...reportBase,
    freshness: carrierFreshness({ yamato: "2026-11-19T00:00:10Z", sagawa: "2026-11-19T00:00:20Z" }),
  });
  assert.match(message, /最終確認 \(JST\): yamato 11\/19 09:00 \/ sagawa 11\/19 09:00 \/ japan_post 未確認/);
  assert.doesNotMatch(message, /要確認/);
});
