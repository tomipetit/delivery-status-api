import assert from "node:assert/strict";
import test from "node:test";

import { extractRestrictions } from "../src/ai/terra.ts";
import type { SourceDocument } from "../src/types/restriction.ts";

// The cap the extractor documents. Kept here as a literal on purpose: reading it
// from the module under test would make the assertions follow a regression.
const extractionInputCharacterLimit = 30000;
const openAiResponsesUrl = "https://api.openai.com/v1/responses";

function yamatoSource(text: string): SourceDocument {
  return {
    carrier: "yamato",
    url: "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html",
    text,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function restrictionListResponse(): Response {
  return Response.json({
    status: "completed",
    output_text: JSON.stringify([{
      prefecture: "石川県",
      city: "輪島市",
      area: null,
      status: "suspended",
      services: ["宅急便"],
      reason: "大雨",
    }]),
  });
}

/** Runs `run` with fetch stubbed, returning the single request body it sent. */
async function captureExtractionRequest(
  source: SourceDocument,
  respond: () => Response = restrictionListResponse,
): Promise<{ body: Record<string, any>; warnings: string[] }> {
  const bodies: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async (input, init) => {
    assert.equal(requestUrl(input), openAiResponsesUrl);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
    return respond();
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    await extractRestrictions(source, "key", "model");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.equal(bodies.length, 1, "extraction must issue exactly one OpenAI request");
  return { body: bodies[0], warnings };
}

async function rejectedExtractionError(respond: () => Response): Promise<Error> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respond();

  try {
    const reason = await extractRestrictions(yamatoSource("石川県 | 輪島市 |"), "key", "model")
      .then(() => null, (error: unknown) => error);
    assert.ok(reason instanceof Error, "extraction must reject with an Error");
    return reason;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("extraction requests low reasoning effort and a bounded max_output_tokens", async () => {
  const { body } = await captureExtractionRequest(yamatoSource("石川県 | 輪島市 |"));

  assert.deepEqual(body.reasoning, { effort: "low" }, "reasoning tokens are billed; effort must stay low");
  assert.equal(typeof body.max_output_tokens, "number");
  assert.ok(Number.isInteger(body.max_output_tokens), "max_output_tokens must be an integer token ceiling");
  assert.ok(
    body.max_output_tokens > 0 && body.max_output_tokens <= 16000,
    `extraction max_output_tokens must stay bounded, got ${body.max_output_tokens}`,
  );
  assert.ok(
    body.max_output_tokens < 30000,
    "an unbounded extraction ceiling would only surface on the bill",
  );
});

test("extraction truncates a source larger than the documented character cap and says so", async () => {
  // Twice the cap, so a lifted or removed cap blows the length bound below
  // rather than merely losing the tail marker.
  const padding = "あ".repeat(extractionInputCharacterLimit * 2);
  const source = yamatoSource(`石川県 | 輪島市 |\n${padding}\nTAIL-MARKER-MUST-BE-DROPPED`);
  const { body, warnings } = await captureExtractionRequest(source);

  const sentText = String(body.input);
  assert.ok(
    sentText.length <= extractionInputCharacterLimit + 400,
    `only the capped source text plus a short header may be sent, got ${sentText.length} chars`,
  );
  assert.ok(sentText.includes("石川県 | 輪島市 |"), "the head of the source must survive truncation");
  assert.doesNotMatch(sentText, /TAIL-MARKER-MUST-BE-DROPPED/);
  assert.equal(warnings.length, 1, "an actual truncation must be logged once");
  assert.match(warnings[0], /truncated/);
  assert.match(warnings[0], new RegExp(String(extractionInputCharacterLimit)));
  assert.match(warnings[0], new RegExp(String(source.text.length)));
});

test("extraction sends a source under the cap whole and warns about nothing", async () => {
  const source = yamatoSource(`石川県 | 輪島市 |\n${"あ".repeat(1000)}\nTAIL-MARKER-MUST-SURVIVE`);
  const { body, warnings } = await captureExtractionRequest(source);

  const sentText = String(body.input);
  assert.ok(sentText.includes(source.text), "a source under the cap must reach the model untruncated");
  assert.match(sentText, /TAIL-MARKER-MUST-SURVIVE/);
  assert.deepEqual(warnings, [], "no truncation happened, so nothing may be logged");
});

test("extraction rejects an incomplete response naming max_output_tokens instead of parsing its partial JSON", async () => {
  const error = await rejectedExtractionError(() => Response.json({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    // A cut-off response can still carry parseable records; accepting them would
    // silently store a shortened restriction list.
    output_text: JSON.stringify([{ prefecture: "石川県", city: "輪島市", status: "suspended" }]),
  }));

  assert.match(error.message, /OpenAI extraction failed/);
  assert.match(error.message, /incomplete/);
  assert.match(error.message, /reason=max_output_tokens/);
  assert.doesNotMatch(
    error.message,
    /not valid JSON|not a JSON array/,
    "the guard must stop before parsing rather than fall through to it",
  );
});

test("extraction rejects any status other than completed, matching the research call site", async () => {
  for (const status of ["failed", "in_progress", "cancelled"]) {
    const error = await rejectedExtractionError(() => Response.json({
      status,
      // No incomplete_details: without a status check this would fall through to
      // the parser and surface as a vague JSON error instead of an API status.
      output_text: JSON.stringify([{ prefecture: "石川県", city: "輪島市", status: "suspended" }]),
    }));

    assert.match(error.message, new RegExp(`response status=${status}`));
    assert.doesNotMatch(
      error.message,
      /not valid JSON|not a JSON array/,
      "the status guard must stop before parsing rather than fall through to it",
    );
  }
});

test("extraction rejects a non-JSON body with a named error rather than a bare SyntaxError", async () => {
  const error = await rejectedExtractionError(() => Response.json({
    status: "completed",
    output_text: "申し訳ありませんが、抽出できませんでした。",
  }));

  assert.ok(!(error instanceof SyntaxError), "a raw SyntaxError hides which call failed");
  assert.match(error.message, /OpenAI extraction failed: output text was not valid JSON/);
  assert.match(error.message, /chars/, "the error must report how much text was received");
});

test("extraction rejects a body that parses to something other than an array of restrictions", async () => {
  const error = await rejectedExtractionError(() => Response.json({
    status: "completed",
    output_text: JSON.stringify({ restrictions: [{ prefecture: "石川県" }] }),
  }));

  assert.match(error.message, /OpenAI extraction failed: output was not a JSON array of restrictions/);
});
