import assert from "node:assert/strict";
import test from "node:test";

import { extractRestrictionsFromPdf } from "../src/ai/terra.ts";
import type { SourceDocument } from "../src/types/restriction.ts";

const pdfUrl = "https://www.post.japanpost.jp/assets/docs/service/unkou.pdf";
const openAiResponsesUrl = "https://api.openai.com/v1/responses";
const japanPostSource: Omit<SourceDocument, "text"> = {
  carrier: "japan_post",
  url: pdfUrl,
};

function samplePdf(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  // Real bytes, including the 0x00-0xff range an encoder can mangle.
  for (let index = 0; index < size; index += 1) bytes[index] = index % 256;
  bytes.set(new TextEncoder().encode("%PDF-1.7"), 0);
  return bytes;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function determinationResponse(
  determination: string,
  restrictions: unknown[],
): Response {
  return Response.json({
    status: "completed",
    output: [{
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ determination, restrictions }) }],
    }],
  });
}

const activeRestriction = {
  prefecture: "鹿児島県",
  city: "奄美市",
  area: null,
  status: "suspended",
  services: ["保冷扱いゆうパック"],
  reason: "台風15号",
  // Deliberately present and wrong: the extractor must ignore any model URL.
  sourceUrl: "https://example.invalid/not-official",
};

/** Runs the PDF extraction with fetch stubbed, returning the single request body. */
async function captureRequest(
  pdf: Uint8Array | ArrayBuffer,
  respond: () => Response,
): Promise<{ body: Record<string, any>; calls: number }> {
  const bodies: Array<Record<string, any>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(requestUrl(input), openAiResponsesUrl);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
    return respond();
  };

  try {
    await extractRestrictionsFromPdf(japanPostSource, pdf, "key", "model");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies.length, 1, "PDF extraction must issue exactly one OpenAI request");
  return { body: bodies[0], calls: bodies.length };
}

async function rejectedError(respond: () => Response): Promise<Error> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respond();

  try {
    const reason = await extractRestrictionsFromPdf(japanPostSource, samplePdf(), "key", "model")
      .then(() => null, (error: unknown) => error);
    assert.ok(reason instanceof Error, "PDF extraction must reject with an Error");
    return reason;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Japan Post extraction attaches the downloaded PDF instead of searching for it", async () => {
  const pdf = samplePdf(512);
  const { body } = await captureRequest(
    pdf,
    () => determinationResponse("active_restrictions_found", [activeRestriction]),
  );

  assert.equal(body.model, "model");
  assert.equal(body.tools, undefined, "the PDF is attached, so no tool may be requested");
  // Nothing in the request may ask the model to go looking for the document:
  // no tool declaration and no search configuration of any kind.
  assert.doesNotMatch(JSON.stringify(body), /tool|search/i);

  const content = body.input[0].content;
  assert.equal(body.input[0].role, "user");
  assert.equal(content[0].type, "input_file");
  assert.equal(content[0].filename, "unkou.pdf");
  assert.match(content[0].file_data, /^data:application\/pdf;base64,/);
  assert.equal(
    content[0].file_data,
    `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`,
    "the attached bytes must be the exact PDF that was downloaded",
  );
  assert.equal(content[1].type, "input_text");
  assert.match(content[1].text, new RegExp(pdfUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(String(body.instructions), /determination/);
  assert.match(String(body.instructions), /unreadable/);
  assert.match(String(body.instructions), /carrier must be japan_post/);
});

test("Japan Post extraction keeps the cost guards the research path had", async () => {
  const { body } = await captureRequest(
    samplePdf(),
    () => determinationResponse("no_active_restrictions", []),
  );

  assert.deepEqual(body.reasoning, { effort: "low" }, "reasoning tokens are billed; effort must stay low");
  assert.equal(typeof body.max_output_tokens, "number");
  assert.ok(Number.isInteger(body.max_output_tokens), "max_output_tokens must be an integer token ceiling");
  assert.ok(
    body.max_output_tokens > 0 && body.max_output_tokens <= 16000,
    `PDF extraction max_output_tokens must stay bounded, got ${body.max_output_tokens}`,
  );
});

test("Japan Post extraction base64-encodes a full-size PDF without blowing the stack", async () => {
  // Larger than the real ~276KB document and far past the argument-count limit
  // that a single String.fromCharCode(...bytes) spread would hit.
  const pdf = samplePdf(400_000);
  const { body } = await captureRequest(
    // Passed as raw bytes, the way fetchJapanPostFingerprint hands them over.
    pdf.buffer as ArrayBuffer,
    () => determinationResponse("no_active_restrictions", []),
  );

  assert.equal(
    body.input[0].content[0].file_data,
    `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`,
  );
});

test("Japan Post extraction stamps the official PDF URL on every record it returns", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => determinationResponse("active_restrictions_found", [
    activeRestriction,
    { ...activeRestriction, city: "奄美市", area: null },
    { prefecture: "沖縄県", city: null, area: null, status: "partially_suspended", services: ["保冷扱いゆうパック"], reason: null },
  ]);

  try {
    const result = await extractRestrictionsFromPdf(japanPostSource, samplePdf(), "key", "model");

    assert.equal(result.determination, "active_restrictions_found");
    // The duplicate collapsed, and the model's own URL never survives.
    assert.equal(result.restrictions.length, 2);
    for (const restriction of result.restrictions) {
      assert.equal(restriction.carrier, "japan_post");
      assert.equal(restriction.sourceUrl, pdfUrl);
    }
    assert.equal(result.restrictions[0].prefecture, "鹿児島県");
    assert.equal(result.restrictions[1].status, "partially_suspended");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japan Post extraction returns an authoritative empty set for no_active_restrictions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => determinationResponse("no_active_restrictions", []);

  try {
    const result = await extractRestrictionsFromPdf(japanPostSource, samplePdf(), "key", "model");

    assert.equal(result.determination, "no_active_restrictions");
    assert.deepEqual(result.restrictions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japan Post extraction rejects an unreadable determination instead of storing nothing", async () => {
  const error = await rejectedError(() => determinationResponse("unreadable", []));

  assert.match(error.message, /OpenAI PDF extraction failed/);
  assert.match(error.message, /could not read the document/);
});

test("Japan Post extraction rejects a determination that contradicts its record count", async () => {
  const empty = await rejectedError(() => determinationResponse("active_restrictions_found", []));
  assert.match(empty.message, /active determination requires restrictions/);

  const contradicting = await rejectedError(
    () => determinationResponse("no_active_restrictions", [activeRestriction]),
  );
  assert.match(contradicting.message, /no-active determination requires empty restrictions/);

  // Records that all fail validation leave an empty list, which must not pass as
  // an active determination either.
  const unusable = await rejectedError(
    () => determinationResponse("active_restrictions_found", [{ prefecture: "", city: null, area: null }]),
  );
  assert.match(unusable.message, /active determination requires restrictions/);
});

test("Japan Post extraction rejects an invalid determination, shape, or truncated response", async () => {
  const invalid = await rejectedError(() => determinationResponse("maybe", []));
  assert.match(invalid.message, /determination is invalid/);

  const bareArray = await rejectedError(() => Response.json({
    status: "completed",
    output_text: JSON.stringify([activeRestriction]),
  }));
  assert.match(bareArray.message, /output was not a JSON object/);

  const notArray = await rejectedError(() => Response.json({
    status: "completed",
    output_text: JSON.stringify({ determination: "active_restrictions_found", restrictions: {} }),
  }));
  assert.match(notArray.message, /restrictions was not a JSON array/);

  const truncated = await rejectedError(() => Response.json({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: JSON.stringify({ determination: "no_active_restrictions", restrictions: [] }),
  }));
  assert.match(truncated.message, /reason=max_output_tokens/);
  assert.doesNotMatch(
    truncated.message,
    /not valid JSON|not a JSON object/,
    "the guard must stop before parsing rather than fall through to it",
  );
});
