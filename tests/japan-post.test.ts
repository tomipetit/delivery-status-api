import assert from "node:assert/strict";
import test from "node:test";

import { researchCarrierRestrictions } from "../src/ai/terra.ts";

const officialUrl = "https://www.post.japanpost.jp/notification/productinformation/2026/0815_01.html";
const trustedStatusUrl = "https://www.post.japanpost.jp/assets/docs/service/unkou.pdf";

test("Japan Post research uses only its official domain and asks for no postal codes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    assert.deepEqual(body.tools, [{
      type: "web_search",
      search_context_size: "medium",
      filters: { allowed_domains: ["post.japanpost.jp"] },
    }]);
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.include, ["web_search_call.action.sources"]);
    assert.match(body.input, /^日本郵便が現在配送を停止している地域を抽出できる？郵便番号は無し。/);
    assert.match(body.input, /郵便番号も出力しないでください。/);
    assert.match(body.input, /使用できる根拠は post\.japanpost\.jp またはそのサブドメインの公式ページだけです。/);
    assert.match(body.input, new RegExp(trustedStatusUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(body.input, /一般検索結果/);
    assert.doesNotMatch(body.input, /information\/detail\/320/);
    assert.doesNotMatch(body.input, /石川県能登半島で発生した地震・大雨に伴う配送への影響について/);

    return Response.json({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { sources: [{ type: "url", url: officialUrl }] },
        },
        {
          type: "message",
          status: "completed",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              determination: "active_restrictions_found",
              restrictions: [{
                prefecture: "石川県",
                city: "輪島市",
                area: null,
                status: "suspended",
                services: ["ゆうパック"],
                reason: "大雨",
                sourceUrl: officialUrl,
                sourcePublishedAt: "2026-08-15",
              }],
              sourceUrls: [officialUrl],
            }),
          }],
        },
      ],
    });
  };

  try {
    const now = new Date("2026-08-15T03:04:05.000Z");
    const result = await researchCarrierRestrictions("japan_post", "key", "model", now);

    assert.equal(result.determination, "active_restrictions_found");
    assert.deepEqual(result.restrictions, [{
      carrier: "japan_post",
      prefecture: "石川県",
      city: "輪島市",
      area: null,
      status: "suspended",
      services: ["ゆうパック"],
      reason: "大雨",
      sourceUrl: officialUrl,
      sourcePublishedAt: "2026-08-15",
      checkedAt: now.toISOString(),
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japan Post research requests low reasoning effort, a bounded token ceiling, and medium search context", async () => {
  let body: Record<string, any> | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, any>;
    return Response.json({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { sources: [{ type: "url", url: officialUrl }] },
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              determination: "no_active_restrictions",
              restrictions: [],
              sourceUrls: [officialUrl],
            }),
          }],
        },
      ],
    });
  };

  try {
    await researchCarrierRestrictions("japan_post", "key", "model", new Date("2026-08-15T03:04:05.000Z"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const request = body as unknown as Record<string, any>;
  assert.ok(request, "the research request body must be captured");
  assert.deepEqual(request.reasoning, { effort: "low" }, "reasoning tokens are billed and must stay at low effort");
  assert.equal(typeof request.max_output_tokens, "number");
  assert.ok(Number.isInteger(request.max_output_tokens), "max_output_tokens must be an integer token ceiling");
  assert.ok(
    request.max_output_tokens > 0 && request.max_output_tokens <= 32000,
    `research max_output_tokens must stay bounded, got ${request.max_output_tokens}`,
  );
  // "high" is the expensive tier and "low" raises the odds of an outright sync
  // failure, so the tier is asserted exactly rather than as "not high".
  assert.equal(request.tools[0].search_context_size, "medium");
});

test("Japan Post research accepts only the exact trusted unkou.pdf URL without action sources", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { sources: [] },
      },
      {
        type: "message",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            determination: "active_restrictions_found",
            restrictions: [{
              prefecture: "石川県",
              city: "輪島市",
              area: null,
              status: "suspended",
              services: ["ゆうパック"],
              reason: "大雨",
              sourceUrl: trustedStatusUrl,
              sourcePublishedAt: null,
            }],
            sourceUrls: [],
          }),
        }],
      },
    ],
  });

  try {
    const result = await researchCarrierRestrictions(
      "japan_post",
      "key",
      "model",
      new Date("2026-08-15T03:04:05.000Z"),
    );

    assert.deepEqual(result.sourceUrls, [trustedStatusUrl]);
    assert.equal(result.restrictions[0]?.sourceUrl, trustedStatusUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
