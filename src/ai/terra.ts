import type { Carrier, DeliveryRestriction, SourceDocument } from "../types/restriction";

interface OpenAIContent {
  type?: unknown;
  text?: unknown;
}

interface OpenAIOutputItem {
  type?: unknown;
  content?: unknown;
}

interface OpenAIResponse {
  status?: unknown;
  output_text?: unknown;
  output?: unknown;
  error?: unknown;
  incomplete_details?: unknown;
  usage?: unknown;
}

/** A source whose bytes are sent to the model instead of scraped text. */
export type BinarySourceDocument = Omit<SourceDocument, "text">;

export type PdfDetermination =
  | "active_restrictions_found"
  | "no_active_restrictions"
  | "unreadable";

export interface JapanPostExtractionResult {
  // "unreadable" never reaches a caller: it is turned into a thrown error so the
  // sync layer keeps the stored rows instead of replacing them with nothing.
  determination: Exclude<PdfDetermination, "unreadable">;
  restrictions: DeliveryRestriction[];
}

// Cost guard. In the Responses API max_output_tokens covers reasoning tokens as
// well as visible output, so this is sized well above the visible JSON: a value
// tuned to the answer alone truncates the response mid-reasoning. Every call
// site turns a truncated response into a thrown error rather than accepting a
// partial restriction list, so raising this is safe and lowering it is not.
const EXTRACTION_MAX_OUTPUT_TOKENS = 8000;

// Runaway guard only: real carrier sources are a few kilobytes. Hitting this is
// a signal that the source shape changed, so it is logged rather than silent.
const EXTRACTION_INPUT_CHARACTER_LIMIT = 30000;

// String.fromCharCode is applied per chunk: spreading a whole ~276KB PDF in one
// call overflows the argument stack.
const BASE64_CHUNK_SIZE = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputItems(data: OpenAIResponse): OpenAIOutputItem[] {
  if (!Array.isArray(data.output)) return [];
  return data.output.filter(isRecord);
}

function contentItems(item: OpenAIOutputItem): OpenAIContent[] {
  if (!Array.isArray(item.content)) return [];
  return item.content.filter(isRecord);
}

function readOutputText(data: OpenAIResponse): string {
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  return outputItems(data)
    .flatMap(contentItems)
    .filter((item) => item.type === "output_text" || item.type === "text" || item.type === undefined)
    .map((item) => typeof item.text === "string" ? item.text : "")
    .join("");
}

function cleanNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

// Sagawa closes a town list with a count, as in 門前町滝上（10町）. The count
// annotates the list rather than naming a place, so it must not survive into an
// area. A parenthesised sub-area such as 宝立町（大町泥木・二艘丹）is not a count
// and is left alone.
const TRAILING_COUNT_ANNOTATION =
  /[（(]\s*\d+\s*(?:町|市|区|村|地区|地域|箇所|ヶ所|カ所|か所)\s*[)）]\s*$/;

function stripCountAnnotation(value: string | null): string | null {
  if (value === null) return null;
  const stripped = value.replace(TRAILING_COUNT_ANNOTATION, "").trim();
  return stripped.length > 0 ? stripped : null;
}

function normalizeRestriction(
  source: BinarySourceDocument,
  checkedAt: string,
  item: Partial<DeliveryRestriction>,
): DeliveryRestriction {
  return {
    carrier: source.carrier,
    prefecture: String(item.prefecture ?? "").trim(),
    city: cleanNullableString(item.city),
    area: stripCountAnnotation(cleanNullableString(item.area)),
    status: item.status === "partially_suspended" ? "partially_suspended" : "suspended",
    services: Array.isArray(item.services)
      ? [...new Set(item.services.map(String).map((value) => value.trim()).filter(Boolean))]
      : [],
    reason: cleanNullableString(item.reason),
    // Always the URL we fetched ourselves, never a URL the model produced.
    sourceUrl: source.url,
    sourcePublishedAt: source.publishedAt ?? null,
    checkedAt,
  };
}

function isValidRestriction(item: DeliveryRestriction): boolean {
  if (!item.prefecture) return false;

  // A town/area without its municipality is unsafe for delivery decisions.
  if (item.area && !item.city) return false;

  return true;
}

export function deduplicateRestrictions(items: DeliveryRestriction[]): DeliveryRestriction[] {
  const unique = new Map<string, DeliveryRestriction>();

  for (const item of items) {
    const key = [
      item.carrier,
      item.prefecture,
      item.city ?? "",
      item.area ?? "",
      item.status,
      [...item.services].sort().join(","),
    ].join("|");

    if (!unique.has(key)) unique.set(key, item);
  }

  return [...unique.values()];
}

function apiErrorSummary(value: unknown): string {
  if (!isRecord(value)) return "unknown API error";
  const type = typeof value.type === "string" ? value.type : null;
  const code = typeof value.code === "string" ? value.code : null;
  const parts = [type && `type=${type}`, code && `code=${code}`].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "unknown API error";
}

async function readJsonResponse(response: Response, operation: string): Promise<OpenAIResponse> {
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id");
    throw new Error(
      `${operation} failed: HTTP ${response.status}${requestId ? ` requestId=${requestId}` : ""}`,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${operation} failed: invalid JSON response`);
  }

  if (!isRecord(data)) throw new Error(`${operation} failed: invalid response object`);
  if (data.error !== null && data.error !== undefined) {
    throw new Error(`${operation} failed: ${apiErrorSummary(data.error)}`);
  }
  return data;
}

function numericField(record: Record<string, unknown>, field: string): number | null {
  return typeof record[field] === "number" ? record[field] : null;
}

function nestedNumericField(
  record: Record<string, unknown>,
  container: string,
  field: string,
): number | null {
  const details = record[container];
  return isRecord(details) ? numericField(details, field) : null;
}

/**
 * Emits one greppable line per billed call. Reasoning tokens are charged
 * separately from the visible answer, so they are recorded too: without this the
 * only place the spend is visible is the invoice.
 */
function logTokenUsage(operation: string, model: string, data: OpenAIResponse): void {
  if (!isRecord(data.usage)) {
    console.info(`[usage] operation=${operation} model=${model} usage=unavailable`);
    return;
  }

  const fields = [
    `input=${numericField(data.usage, "input_tokens") ?? "?"}`,
    `cached=${nestedNumericField(data.usage, "input_tokens_details", "cached_tokens") ?? 0}`,
    `output=${numericField(data.usage, "output_tokens") ?? "?"}`,
    `reasoning=${nestedNumericField(data.usage, "output_tokens_details", "reasoning_tokens") ?? 0}`,
    `total=${numericField(data.usage, "total_tokens") ?? "?"}`,
  ];

  console.info(`[usage] operation=${operation} model=${model} ${fields.join(" ")}`);
}

function incompleteReason(data: OpenAIResponse): string | null {
  if (!isRecord(data.incomplete_details)) return null;
  return typeof data.incomplete_details.reason === "string" ? data.incomplete_details.reason : null;
}

/** Rules shared by every extraction, whatever the source is carried in. */
const RESTRICTION_RULES = [
  "Include pickup suspension, acceptance suspension, delivery suspension, and explicitly restricted service availability.",
  "For Yamato, treat only rows supported by an explicit 荷受け停止 or 集荷・配達停止 statement as suspension records.",
  "A section heading alone does not make every row suspended; read each row's service and remarks columns.",
  "Include 成田国際空港 when the row states that 空港宅急便 acceptance is suspended, and set services to the affected named service rather than excluding a service-limited suspension.",
  "Sagawa articles state the same facts as prose rather than as a status table; apply the same rules to sentences.",
  "Statements such as お預かり（荷受け）は停止しております, 発送を一時停止, 引き受けが一時停止, and お預かり・お届けを停止している地域 are suspensions and must be returned.",
  "A suspension limited to a named service, such as 飛脚グローバルポスト便 米国宛て, is still a restriction: return it with that service in services.",
  "When a 停止 heading is followed by a table whose columns are 都道府県 / 市区郡 / 地域名, map those columns to prefecture / city / area for that section only.",
  "A table under a 遅れ or 遅延 heading in the same article describes delays only and must not be returned.",
  "Exclude mere delays, shortened business hours, shortened pickup cut-off times, and records explicitly saying pickup/delivery is still operating.",
  "Phrases such as お届けに遅れ, 遅延, 大幅な遅れ, 遅延了承のうえお預かり, 集荷・配達を行っております, and 集荷・配達を実施 indicate that the row must not be returned as a suspension.",
  "Do not invent, infer, or autocomplete a location that is not present in the source.",
  "prefecture must contain the prefecture name (for example 石川県).",
  "city must contain the municipality or district-level name shown in the source (for example 輪島市, 鳳珠郡能登町).",
  "area is only for a locality below city, such as a town or a parenthesized sub-area.",
  "If the source says 輪島市（門前町西円山・別所谷町）, output city=輪島市 and area=門前町西円山・別所谷町.",
  "area must contain place names only. Drop a bracketed count that annotates the list rather than naming a place: 小池町,下山町,門前町滝上（10町） becomes 小池町,下山町,門前町滝上.",
  "If area is non-null, city must also be non-null. Never output an area without its municipality.",
  "city may be null only when the restriction clearly applies to the entire prefecture.",
  "When one source row contains multiple municipalities, create separate records when their hierarchy can be determined from the source.",
  "Do not turn a delay-only row into a suspension record just because another section on the page contains suspensions.",
  "status must be suspended or partially_suspended.",
  "services must be an array of affected service/product names; use [] only when the source does not specify them.",
  "reason must carry the cause the source gives for the suspension, quoted closely from it: 地震・大雨, 令和8年熊本地震の影響, 台風13号及び台風15号の影響.",
  "The cause is often stated once in a heading or an opening sentence rather than in the row itself; apply it to the records that section covers.",
  "reason may be null only when the source states no cause at all. Never invent one.",
] as const;

function extractionInstructions(carrier: Carrier, outputContract: readonly string[]): string {
  return [
    "You extract Japanese delivery restrictions from official carrier source text.",
    ...outputContract,
    ...RESTRICTION_RULES,
    `carrier must be ${carrier}.`,
  ].join("\n");
}

/**
 * One billed Responses call plus every guard that must run before its output is
 * trusted. Returns the raw output text; the caller decides what shape it must
 * have. Shared so the text and PDF paths cannot drift apart.
 */
async function requestExtraction(
  operation: string,
  usageLabel: string,
  apiKey: string,
  model: string,
  instructions: string,
  input: unknown,
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // Reasoning tokens are billed and count against max_output_tokens, so both
      // are bounded here.
      reasoning: { effort: "low" },
      max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      instructions,
      input,
    }),
  });

  const data = await readJsonResponse(response, operation);
  // Logged before the guards below: a truncated or refused response is billed too.
  logTokenUsage(usageLabel, model, data);
  // A response cut off by max_output_tokens can still carry parseable JSON for
  // the records it managed to emit, which would look like a shorter but valid
  // restriction list. Fail loudly instead: the sync layer treats this as a
  // carrier failure and keeps the existing data. Any status other than
  // completed — failed and in_progress included — must not reach the parser.
  const truncationReason = incompleteReason(data);
  if (data.status !== "completed" || truncationReason !== null) {
    const limit = truncationReason === "max_output_tokens"
      ? ` max_output_tokens=${EXTRACTION_MAX_OUTPUT_TOKENS}`
      : "";
    throw new Error(
      `${operation} failed: response status=${String(data.status ?? "missing")}`
        + `${truncationReason ? ` reason=${truncationReason}` : ""}${limit}`,
    );
  }

  return readOutputText(data).trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
}

function parseOutputJson(raw: string, operation: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `${operation} failed: output text was not valid JSON`
        + ` (${raw.length} chars; a cut-off response is the usual cause)`,
    );
  }
}

function finalizeRestrictions(
  source: BinarySourceDocument,
  checkedAt: string,
  items: unknown[],
): DeliveryRestriction[] {
  const normalized = (items as Array<Partial<DeliveryRestriction>>)
    .map((item) => normalizeRestriction(source, checkedAt, item))
    .filter(isValidRestriction);

  return deduplicateRestrictions(normalized);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function pdfFilename(url: string): string {
  const name = url.split("?")[0].split("#")[0].split("/").pop() ?? "";
  return /^[\w.-]+\.pdf$/i.test(name) ? name : "source.pdf";
}

const PDF_OUTPUT_CONTRACT = [
  "The user message attaches the official carrier PDF. It is the complete current status document: read it end to end.",
  'Return JSON only: an object shaped {"determination": string, "restrictions": array}.',
  "determination must be active_restrictions_found, no_active_restrictions, or unreadable.",
  "Use active_restrictions_found when the document shows currently active restrictions, and return every one of them in restrictions.",
  "Use no_active_restrictions only when you read the whole document and it shows no currently active restriction; restrictions must then be an empty array.",
  "Use unreadable when you cannot read the document contents; restrictions must then be an empty array.",
  "Never answer no_active_restrictions when the document is unreadable or only partly readable: answer unreadable instead.",
  "restrictions is an array of currently active delivery suspension records.",
] as const;

/**
 * Extracts restrictions straight from the official PDF bytes we downloaded.
 *
 * No URL trust checking is needed here, unlike a search-driven path: every
 * record's sourceUrl is the official URL this worker fetched itself, so the
 * model never gets to name its own source.
 */
export async function extractRestrictionsFromPdf(
  source: BinarySourceDocument,
  pdf: ArrayBuffer | Uint8Array,
  apiKey: string,
  model: string,
): Promise<JapanPostExtractionResult> {
  const operation = "OpenAI PDF extraction";
  const checkedAt = new Date().toISOString();
  const bytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf);
  const filename = pdfFilename(source.url);
  const raw = await requestExtraction(
    operation,
    `${source.carrier}-pdf-extract`,
    apiKey,
    model,
    extractionInstructions(source.carrier, PDF_OUTPUT_CONTRACT),
    [{
      role: "user",
      content: [
        {
          type: "input_file",
          filename,
          file_data: `data:application/pdf;base64,${encodeBase64(bytes)}`,
        },
        {
          type: "input_text",
          text: `SOURCE URL: ${source.url}\nCHECKED AT: ${checkedAt}\n\n`
            + "添付の公式PDFを最初から最後まで読み、現在有効な配送制限を抽出してください。",
        },
      ],
    }],
  );

  const parsed = parseOutputJson(raw, operation);
  if (!isRecord(parsed)) {
    throw new Error(`${operation} failed: output was not a JSON object`);
  }
  const { determination } = parsed;
  if (
    determination !== "active_restrictions_found"
    && determination !== "no_active_restrictions"
    && determination !== "unreadable"
  ) {
    throw new Error(`${operation} failed: determination is invalid`);
  }
  if (!Array.isArray(parsed.restrictions)) {
    throw new Error(`${operation} failed: restrictions was not a JSON array`);
  }

  const restrictions = finalizeRestrictions(source, checkedAt, parsed.restrictions);

  // Only an explicit, document-backed determination may authorize destructive
  // replacement downstream. An unreadable document, or a determination that
  // disagrees with the records that came with it, fails the carrier instead.
  if (determination === "unreadable") {
    throw new Error(`${operation} failed: the model could not read the document`);
  }
  if (determination === "active_restrictions_found" && restrictions.length === 0) {
    throw new Error(`${operation} failed: active determination requires restrictions`);
  }
  if (determination === "no_active_restrictions" && restrictions.length > 0) {
    throw new Error(`${operation} failed: no-active determination requires empty restrictions`);
  }

  return { determination, restrictions };
}

export async function extractRestrictions(
  source: SourceDocument,
  apiKey: string,
  model: string,
): Promise<DeliveryRestriction[]> {
  const operation = "OpenAI extraction";
  const checkedAt = new Date().toISOString();
  const inputText = source.text.slice(0, EXTRACTION_INPUT_CHARACTER_LIMIT);
  if (inputText.length < source.text.length) {
    console.warn(
      `[extract] ${source.carrier} source text truncated for the model:`
        + ` ${source.text.length} chars exceeds the ${EXTRACTION_INPUT_CHARACTER_LIMIT} character cap (${source.url})`,
    );
  }

  const raw = await requestExtraction(
    operation,
    `${source.carrier}-extract`,
    apiKey,
    model,
    extractionInstructions(source.carrier, [
      "Return JSON only: an array of currently active delivery suspension records.",
    ]),
    `SOURCE URL: ${source.url}\nCHECKED AT: ${checkedAt}\n\n${inputText}`,
  );

  const parsed = parseOutputJson(raw, operation);
  if (!Array.isArray(parsed)) {
    throw new Error(`${operation} failed: output was not a JSON array of restrictions`);
  }

  return finalizeRestrictions(source, checkedAt, parsed);
}
