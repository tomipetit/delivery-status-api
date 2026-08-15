import assert from "node:assert/strict";
import test from "node:test";

import { htmlToStructuredText } from "../src/scrapers/html.ts";
import { extractYamatoStatusText, yamatoFingerprintText } from "../src/scrapers/yamato.ts";
import { sha256Hex } from "../src/source-fingerprint.ts";
import { SyncError, syncAll, type SyncEnv } from "../src/sync.ts";
import { createInMemoryD1, sourceState } from "./helpers/in-memory-d1.ts";

const yamatoUrl = "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html";
const sagawaListUrl = "https://www2.sagawa-exp.co.jp/information/list/";
const sagawaListXmlUrl = "https://www2.sagawa-exp.co.jp/sagawa_xml/importance/importance_list.xml";
const sagawaArticle321 = "https://www2.sagawa-exp.co.jp/information/detail/321/";
const sagawaArticle999 = "https://www2.sagawa-exp.co.jp/information/detail/999/";

function sagawaArticleXmlUrl(id: string): string {
  return `https://www2.sagawa-exp.co.jp/sagawa_xml/importance/importance_detail_${id}.xml`;
}
const japanPostPdfUrl = "https://www.post.japanpost.jp/assets/docs/service/unkou.pdf";
const model = "test-model";
const openAiResponsesUrl = "https://api.openai.com/v1/responses";

function todayIso(): string {
  return new Date().toISOString();
}

function yesterdayIso(): string {
  return new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
}

function env(db: D1Database): SyncEnv {
  return {
    DB: db,
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: model,
  };
}

function currentSkipStates(overrides: Record<string, ReturnType<typeof sourceState>> = {}) {
  const checkedAt = todayIso();
  return {
    yamato: sourceState("yamato", `yamato:v3:model=${model}:skip`, checkedAt),
    sagawa: sourceState("sagawa", `sagawa:xml-v1:model=${model}:skip`, checkedAt),
    japan_post: sourceState("japan_post", `japan-post:pdf-v1:model=${model}:pdfsha=skip`, checkedAt),
    ...overrides,
  };
}

function yamatoPage(area = "輪島市"): string {
  return [
    "<p>●下記地域のお荷物について、荷受けを停止しております</p>",
    `<table><tr><td>石川県</td><td>${area}</td><td>宅急便</td></tr></table>`,
    "<p>●営業所の営業時間に関するお知らせ</p>",
  ].join("");
}

function sagawaListXml(
  entries: Array<{ id: string; title?: string; publishedAt?: string }>,
): string {
  const informations = entries.map(({ id, title = "配送への影響について", publishedAt = "2026-08-15" }) => {
    const [year, month, day] = publishedAt.split("-");
    return [
      "  <information>",
      `    <i_id>${id}</i_id>`,
      `    <year>${year}</year>`,
      `    <month>${month}</month>`,
      `    <day>${day}</day>`,
      `    <title><![CDATA[${title}]]></title>`,
      `    <link_url>https://www2.sagawa-exp.co.jp/information/detail/${id}/</link_url>`,
      "    <pdf_size/>",
      "  </information>",
    ].join("\n");
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<informations>\n${informations}\n</informations>\n`;
}

function sagawaArticleXml(id: string, publishedAt = "2026-08-15"): string {
  const [year, month, day] = publishedAt.split("-");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<information>",
    `  <year>${year}</year>`,
    `  <month>${month}</month>`,
    `  <day>${day}</day>`,
    "  <title><![CDATA[配送への影響について]]></title>",
    `  <link_url>https://www2.sagawa-exp.co.jp/information/detail/${id}/</link_url>`,
    "  <news><![CDATA[<p>【お荷物のお預かり・お届けを停止している地域】<br />北海道 函館市</p>]]></news>",
    "</information>",
  ].join("\n");
}

function sagawaExtractionResponse(): Response {
  return Response.json({
    status: "completed",
    output_text: JSON.stringify([{
      prefecture: "北海道",
      city: "函館市",
      area: null,
      status: "suspended",
      services: ["飛脚宅配便"],
      reason: "大雨",
    }]),
  });
}

function japanPostPdfResponse(
  determination: "active_restrictions_found" | "no_active_restrictions" | "unreadable" = "active_restrictions_found",
  restrictions: unknown[] = determination === "active_restrictions_found"
    ? [{
      prefecture: "石川県",
      city: "輪島市",
      area: null,
      status: "suspended",
      services: ["ゆうパック"],
      reason: "大雨",
    }]
    : [],
): Response {
  return Response.json({
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify({ determination, restrictions }) }],
    }],
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function quietSync<T>(run: () => Promise<T>): Promise<T> {
  const originals = [console.info, console.warn, console.error] as const;
  console.info = console.warn = console.error = () => undefined;
  try {
    return await run();
  } finally {
    [console.info, console.warn, console.error] = originals;
  }
}

test("Yamato same fingerprint avoids OpenAI and replacement, reuses count, and updates checked time", async () => {
  const html = yamatoPage();
  const extracted = extractYamatoStatusText(htmlToStructuredText(html));
  const fingerprint = `yamato:v3:model=${model}:${await sha256Hex(yamatoFingerprintText(extracted))}`;
  const previousCheckedAt = yesterdayIso();
  const memory = createInMemoryD1({
    counts: { yamato: 7, sagawa: 2, japan_post: 3 },
    states: currentSkipStates({ yamato: sourceState("yamato", fingerprint, previousCheckedAt, [yamatoUrl]) }),
  });
  let openAiCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === yamatoUrl) return new Response(html);
    if (url === "https://api.openai.com/v1/responses") openAiCalls += 1;
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    assert.deepEqual(await quietSync(() => syncAll(env(memory.db))), { yamato: 7, sagawa: 2, japan_post: 3 });
    assert.equal(openAiCalls, 0);
    assert.equal(memory.batches.length, 0);
    assert.equal(memory.runs.length, 1);
    assert.notEqual(memory.states.get("yamato")?.last_checked_at, previousCheckedAt);
    assert.equal(memory.states.get("yamato")?.fingerprint, fingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The same page with only Yamato's hourly "…時現在" stamp advanced.
function yamatoPageStampedAt(stamp: string): string {
  return [
    "<p>●下記地域のお荷物について、荷受けを停止しております</p>",
    `<p>${stamp}</p>`,
    "<table><tr><td>石川県</td><td>輪島市</td><td>宅急便</td></tr></table>",
    "<p>●営業所の営業時間に関するお知らせ</p>",
  ].join("");
}

test("Yamato hourly restamp with an unchanged table still avoids the paid extraction", async () => {
  const storedHtml = yamatoPageStampedAt("2026年08月15日　14時現在");
  const servedHtml = yamatoPageStampedAt("2026年08月15日　15時現在");
  const storedText = extractYamatoStatusText(htmlToStructuredText(storedHtml));
  const servedText = extractYamatoStatusText(htmlToStructuredText(servedHtml));
  assert.notEqual(storedText, servedText, "the served page must really differ from the stored one");

  const fingerprint = `yamato:v3:model=${model}:${await sha256Hex(yamatoFingerprintText(storedText))}`;
  const previousCheckedAt = yesterdayIso();
  const memory = createInMemoryD1({
    counts: { yamato: 7, sagawa: 2, japan_post: 3 },
    states: currentSkipStates({ yamato: sourceState("yamato", fingerprint, previousCheckedAt, [yamatoUrl]) }),
  });
  let openAiCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === yamatoUrl) return new Response(servedHtml);
    if (url === "https://api.openai.com/v1/responses") openAiCalls += 1;
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    assert.deepEqual(await quietSync(() => syncAll(env(memory.db))), { yamato: 7, sagawa: 2, japan_post: 3 });
    assert.equal(openAiCalls, 0, "only the timestamp moved, so no extraction may be billed");
    assert.equal(memory.batches.length, 0);
    assert.equal(memory.states.get("yamato")?.fingerprint, fingerprint);
    assert.notEqual(memory.states.get("yamato")?.last_checked_at, previousCheckedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japan Post unchanged PDF hash avoids OpenAI and replacement, reuses count, and updates checked time", async () => {
  const pdf = new TextEncoder().encode("stable japan post PDF");
  const fingerprint = `japan-post:pdf-v1:model=${model}:pdfsha=japan-post-pdf:v1:${await sha256Hex(pdf.buffer)}`;
  const previousCheckedAt = yesterdayIso();
  const memory = createInMemoryD1({
    counts: { yamato: 1, sagawa: 2, japan_post: 21 },
    states: currentSkipStates({ japan_post: sourceState("japan_post", fingerprint, previousCheckedAt, [japanPostPdfUrl]) }),
  });
  let openAiCalls = 0;
  let pdfFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === japanPostPdfUrl) {
      pdfFetches += 1;
      return new Response(pdf);
    }
    if (url === "https://api.openai.com/v1/responses") openAiCalls += 1;
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    assert.deepEqual(await quietSync(() => syncAll(env(memory.db))), { yamato: 1, sagawa: 2, japan_post: 21 });
    assert.equal(pdfFetches, 1, "PDF bytes must be fetched and hashed before deciding it is unchanged");
    assert.equal(openAiCalls, 0);
    assert.equal(memory.batches.length, 0);
    assert.equal(memory.runs.length, 1);
    assert.notEqual(memory.states.get("japan_post")?.last_checked_at, previousCheckedAt);
    assert.equal(memory.states.get("japan_post")?.fingerprint, fingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Sagawa always fetches the official article list but skips extraction for an unchanged article fingerprint", async () => {
  const previousCheckedAt = yesterdayIso();
  const articleFingerprint = await sha256Hex(JSON.stringify({
    url: sagawaArticle321,
    title: "配送への影響について",
    publishedAt: "2026-08-15",
  }));
  const memory = createInMemoryD1({
    counts: { yamato: 1, sagawa: 2, japan_post: 3 },
    states: currentSkipStates({
      sagawa: sourceState("sagawa", `sagawa:xml-v1:model=${model}:old`, previousCheckedAt, [sagawaArticle321]),
    }),
    articles: [{
      carrier: "sagawa",
      source_url: sagawaArticle321,
      fingerprint: articleFingerprint,
      title: "配送への影響について",
      source_updated_at: "2026-08-15",
      restrictions_json: JSON.stringify([{
        carrier: "sagawa", prefecture: "北海道", city: "函館市", area: null,
        status: "suspended", services: ["飛脚宅配便"], reason: "大雨",
        sourceUrl: sagawaArticle321, sourcePublishedAt: "2026-08-15", checkedAt: previousCheckedAt,
      }]),
      extractor_version: `sagawa-xml-v1:model=${model}`,
      last_seen_at: previousCheckedAt,
    }, {
      carrier: "sagawa",
      source_url: "https://www2.sagawa-exp.co.jp/information/detail/100/",
      fingerprint: "removed-article-fingerprint",
      title: "解除済みの記事",
      source_updated_at: "2026-08-01",
      restrictions_json: JSON.stringify([{
        carrier: "sagawa", prefecture: "沖縄県", city: null, area: null,
        status: "suspended", services: ["飛脚宅配便"], reason: "台風",
        sourceUrl: "https://www2.sagawa-exp.co.jp/information/detail/100/",
        sourcePublishedAt: "2026-08-01", checkedAt: previousCheckedAt,
      }]),
      extractor_version: `sagawa-xml-v1:model=${model}`,
      last_seen_at: previousCheckedAt,
    }],
  });
  let listFetches = 0;
  let articleFetches = 0;
  let openAiCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === sagawaListXmlUrl) {
      listFetches += 1;
      return new Response(sagawaListXml([{ id: "321" }]));
    }
    if (url === sagawaArticleXmlUrl("321")) {
      articleFetches += 1;
      return new Response(sagawaArticleXml("321"));
    }
    if (url === "https://api.openai.com/v1/responses") openAiCalls += 1;
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    assert.deepEqual(await quietSync(() => syncAll(env(memory.db))), { yamato: 1, sagawa: 1, japan_post: 3 });
    assert.equal(listFetches, 1);
    assert.equal(articleFetches, 0, "an unchanged article must not be fetched again");
    assert.equal(openAiCalls, 0);
    assert.equal(memory.batches.length, 1);
    assert.notEqual(memory.states.get("sagawa")?.last_checked_at, previousCheckedAt);
    assert.equal(memory.articles.size, 1, "an article absent from the current list must leave the active cache");
    assert.ok(memory.articles.has(`sagawa|${sagawaArticle321}`));
    assert.ok(JSON.parse(memory.states.get("sagawa")?.source_urls_json ?? "[]").includes(sagawaListUrl));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("initial Yamato source runs AI and atomically replaces restrictions with source state", async () => {
  const memory = createInMemoryD1({ states: currentSkipStates() });
  memory.states.delete("yamato");
  let extractionCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === yamatoUrl) return new Response(yamatoPage());
    if (url === "https://api.openai.com/v1/responses") {
      extractionCalls += 1;
      return Response.json({ status: "completed", output_text: JSON.stringify([{
        prefecture: "石川県", city: "輪島市", area: null, status: "suspended",
        services: ["宅急便"], reason: "大雨",
      }]) });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    assert.equal((await quietSync(() => syncAll(env(memory.db)))).yamato, 1);
    assert.equal(extractionCalls, 1);
    assert.equal(memory.batches.length, 1);
    assert.equal(memory.counts.yamato, 1);
    assert.match(memory.states.get("yamato")?.fingerprint ?? "", /^yamato:v3:model=test-model:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("changed Japan Post PDF is downloaded once, attached to the model, and atomically replaces restrictions", async () => {
  const oldFingerprint = `japan-post:pdf-v1:model=${model}:pdfsha=old`;
  const pdfBody = "changed PDF";
  const memory = createInMemoryD1({
    counts: { japan_post: 5 },
    states: currentSkipStates({ japan_post: sourceState("japan_post", oldFingerprint, yesterdayIso()) }),
  });
  let extractionCalls = 0;
  let pdfFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === japanPostPdfUrl) {
      pdfFetches += 1;
      return new Response(pdfBody);
    }
    if (url !== openAiResponsesUrl) throw new Error(`Unexpected fetch: ${url}`);
    extractionCalls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    assert.equal(body.model, model, "the PDF is read by the cheap extraction model");
    assert.equal(body.tools, undefined, "the attached PDF replaces the search-driven path entirely");
    const content = body.input[0].content;
    assert.equal(content[0].type, "input_file");
    assert.equal(
      content[0].file_data,
      `data:application/pdf;base64,${Buffer.from(pdfBody).toString("base64")}`,
      "the model must receive the same bytes that were hashed",
    );
    return japanPostPdfResponse();
  };

  try {
    assert.equal((await quietSync(() => syncAll(env(memory.db)))).japan_post, 1);
    assert.equal(pdfFetches, 1, "the PDF must be downloaded once and reused for both the hash and the model");
    assert.equal(extractionCalls, 1);
    assert.equal(memory.batches.length, 1);
    assert.equal(memory.counts.japan_post, 1);
    assert.match(memory.states.get("japan_post")?.fingerprint ?? "", /^japan-post:pdf-v1:model=test-model:pdfsha=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japan Post no_active_restrictions stores the authoritative empty set", async () => {
  const oldFingerprint = `japan-post:pdf-v1:model=${model}:pdfsha=old`;
  const memory = createInMemoryD1({
    counts: { japan_post: 5 },
    states: currentSkipStates({ japan_post: sourceState("japan_post", oldFingerprint, yesterdayIso()) }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === japanPostPdfUrl) return new Response("empty PDF");
    if (url === openAiResponsesUrl) return japanPostPdfResponse("no_active_restrictions");
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    assert.equal((await quietSync(() => syncAll(env(memory.db)))).japan_post, 0);
    assert.equal(memory.batches.length, 1, "the whole document was read, so the empty set is stored");
    assert.equal(memory.counts.japan_post, 0);
    assert.notEqual(memory.states.get("japan_post")?.fingerprint, oldFingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japan Post unreadable or self-contradicting output fails the carrier and retains its rows", async () => {
  for (const respond of [
    () => japanPostPdfResponse("unreadable"),
    () => japanPostPdfResponse("active_restrictions_found", []),
    () => japanPostPdfResponse("no_active_restrictions", [{
      prefecture: "石川県", city: "輪島市", area: null, status: "suspended", services: [], reason: null,
    }]),
  ]) {
    const oldFingerprint = `japan-post:pdf-v1:model=${model}:pdfsha=old`;
    const memory = createInMemoryD1({
      counts: { japan_post: 9 },
      states: currentSkipStates({ japan_post: sourceState("japan_post", oldFingerprint, yesterdayIso()) }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url === japanPostPdfUrl) return new Response("unreadable PDF");
      if (url === openAiResponsesUrl) return respond();
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      await assert.rejects(quietSync(() => syncAll(env(memory.db))), (error: unknown) => {
        assert.ok(error instanceof SyncError);
        assert.equal(error.counts.japan_post, 9);
        assert.equal(error.failures[0]?.carrier, "japan_post");
        assert.equal(error.failures[0]?.phase, "extract");
        return true;
      });
      assert.equal(memory.batches.length, 0, "a failed determination must never replace stored rows");
      assert.equal(memory.counts.japan_post, 9);
      assert.equal(memory.states.get("japan_post")?.fingerprint, oldFingerprint);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("a newly listed Sagawa article ID is fetched, extracted, and accepted dynamically", async () => {
  const memory = createInMemoryD1({
    counts: { sagawa: 4 },
    states: currentSkipStates({ sagawa: sourceState("sagawa", `sagawa:xml-v1:model=${model}:old`, yesterdayIso()) }),
  });
  let articleFetches = 0;
  let extractionCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === sagawaListXmlUrl) return new Response(sagawaListXml([{ id: "999", publishedAt: "2026-08-16" }]));
    if (url === sagawaArticleXmlUrl("999")) {
      articleFetches += 1;
      return new Response(sagawaArticleXml("999", "2026-08-16"));
    }
    if (url !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected fetch: ${url}`);
    extractionCalls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    assert.equal(body.model, model, "article bodies use the cheap normalization model");
    assert.equal(body.tools, undefined, "article extraction must not request any tool");
    assert.match(body.input, /information\/detail\/999/);
    return sagawaExtractionResponse();
  };

  try {
    assert.equal((await quietSync(() => syncAll(env(memory.db)))).sagawa, 1);
    assert.equal(articleFetches, 1);
    assert.equal(extractionCalls, 1);
    assert.equal(memory.batches.length, 1);
    assert.equal(memory.counts.sagawa, 1);
    assert.match(memory.states.get("sagawa")?.source_urls_json ?? "", /detail\/999/);
    assert.equal(memory.articles.get(`sagawa|${sagawaArticle999}`)?.source_updated_at, "2026-08-16");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed Sagawa article extraction preserves restrictions and fingerprint for retry", async () => {
  const oldFingerprint = `sagawa:xml-v1:model=${model}:old`;
  const memory = createInMemoryD1({
    counts: { sagawa: 6 },
    states: currentSkipStates({ sagawa: sourceState("sagawa", oldFingerprint, yesterdayIso()) }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === sagawaListXmlUrl) return new Response(sagawaListXml([{ id: "999" }]));
    if (url === sagawaArticleXmlUrl("999")) return new Response(sagawaArticleXml("999"));
    if (url !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected fetch: ${url}`);
    return new Response("upstream failure", { status: 500 });
  };

  try {
    await assert.rejects(quietSync(() => syncAll(env(memory.db))), (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.equal(error.counts.sagawa, 6);
      assert.equal(error.failures[0]?.carrier, "sagawa");
      return true;
    });
    assert.equal(memory.batches.length, 0);
    assert.equal(memory.counts.sagawa, 6);
    assert.equal(memory.states.get("sagawa")?.fingerprint, oldFingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("atomic store failure does not advance fingerprint and allows the next run to retry", async () => {
  const oldFingerprint = `japan-post:pdf-v1:model=${model}:pdfsha=old`;
  const memory = createInMemoryD1({
    counts: { japan_post: 8 },
    states: currentSkipStates({ japan_post: sourceState("japan_post", oldFingerprint, yesterdayIso()) }),
  });
  memory.failOnce();
  let extractionCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url === japanPostPdfUrl) return new Response("new PDF");
    if (url === openAiResponsesUrl) {
      extractionCalls += 1;
      return japanPostPdfResponse();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await assert.rejects(quietSync(() => syncAll(env(memory.db))), SyncError);
    assert.equal(memory.counts.japan_post, 8);
    assert.equal(memory.states.get("japan_post")?.fingerprint, oldFingerprint);

    const retryCounts = await quietSync(() => syncAll(env(memory.db)));
    assert.equal(retryCounts.japan_post, 1);
    assert.equal(extractionCalls, 2, "failed atomic store must not suppress next-run extraction");
    assert.notEqual(memory.states.get("japan_post")?.fingerprint, oldFingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
