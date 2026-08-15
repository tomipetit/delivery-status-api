import type { Carrier, DeliveryRestriction, SourceDocument } from "../types/restriction";

interface OpenAIContent {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
  annotations?: unknown;
}

interface OpenAIOutputItem {
  type?: unknown;
  status?: unknown;
  action?: unknown;
  content?: unknown;
}

interface OpenAIResponse {
  id?: unknown;
  status?: unknown;
  output_text?: unknown;
  output?: unknown;
  error?: unknown;
  incomplete_details?: unknown;
  usage?: unknown;
}

export type ResearchCarrier = Extract<Carrier, "japan_post">;
export type ResearchDetermination =
  | "active_restrictions_found"
  | "no_active_restrictions"
  | "insufficient_evidence";

export interface CarrierResearchResult {
  determination: Exclude<ResearchDetermination, "insufficient_evidence">;
  restrictions: DeliveryRestriction[];
  sourceUrls: string[];
}

interface ResearchOutput {
  determination: ResearchDetermination;
  restrictions: unknown[];
  sourceUrls: unknown[];
}

const RESEARCH_CONFIG: Record<ResearchCarrier, {
  displayName: string;
  allowedDomain: string;
  trustedCurrentStatusUrl: string;
}> = {
  japan_post: {
    displayName: "日本郵便",
    allowedDomain: "post.japanpost.jp",
    trustedCurrentStatusUrl: "https://www.post.japanpost.jp/assets/docs/service/unkou.pdf",
  },
};

// Cost guards. In the Responses API max_output_tokens covers reasoning tokens
// as well as visible output, so these are sized well above the visible JSON: a
// value tuned to the answer alone truncates the response mid-reasoning. Both
// call sites turn a truncated response into a thrown error rather than
// accepting a partial restriction list, so raising these is safe and lowering
// them is not.
const RESEARCH_MAX_OUTPUT_TOKENS = 16000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 8000;

// Runaway guard only: real carrier sources are a few kilobytes. Hitting this is
// a signal that the source shape changed, so it is logged rather than silent.
const EXTRACTION_INPUT_CHARACTER_LIMIT = 30000;

function defaultRestrictionUrls(carrier: ResearchCarrier): string[] {
  return [RESEARCH_CONFIG[carrier].trustedCurrentStatusUrl];
}

function researchOutputSchema(carrier: ResearchCarrier, trustedRestrictionUrls: readonly string[]) {
  const { trustedCurrentStatusUrl } = RESEARCH_CONFIG[carrier];
  const allowedSourceUrls = [...new Set([
    trustedCurrentStatusUrl,
    ...trustedRestrictionUrls,
  ])];

  return {
    type: "object",
    additionalProperties: false,
    required: ["determination", "restrictions", "sourceUrls"],
    properties: {
      determination: {
        type: "string",
        enum: [
          "active_restrictions_found",
          "no_active_restrictions",
          "insufficient_evidence",
        ],
      },
      restrictions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "prefecture",
            "city",
            "area",
            "status",
            "services",
            "reason",
            "sourceUrl",
            "sourcePublishedAt",
          ],
          properties: {
            prefecture: { type: "string" },
            city: { type: ["string", "null"] },
            area: { type: ["string", "null"] },
            status: {
              type: "string",
              enum: ["suspended", "partially_suspended"],
            },
            services: {
              type: "array",
              items: { type: "string" },
            },
            reason: { type: ["string", "null"] },
            sourceUrl: {
              type: "string",
              enum: [...trustedRestrictionUrls],
            },
            sourcePublishedAt: { type: ["string", "null"] },
          },
        },
      },
      sourceUrls: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          enum: allowedSourceUrls,
        },
      },
    },
  } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`Carrier research validation failed: ${label} contains an unexpected property`);
  }
  if (expectedKeys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`Carrier research validation failed: ${label} is missing a required property`);
  }
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

function normalizeRestriction(
  source: SourceDocument,
  checkedAt: string,
  item: Partial<DeliveryRestriction>,
): DeliveryRestriction {
  return {
    carrier: source.carrier,
    prefecture: String(item.prefecture ?? "").trim(),
    city: cleanNullableString(item.city),
    area: cleanNullableString(item.area),
    status: item.status === "partially_suspended" ? "partially_suspended" : "suspended",
    services: Array.isArray(item.services)
      ? [...new Set(item.services.map(String).map((value) => value.trim()).filter(Boolean))]
      : [],
    reason: cleanNullableString(item.reason),
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

function formatTokyoTime(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Carrier research failed: invalid current time");

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

function researchPrompt(carrier: ResearchCarrier, now: Date): string {
  const { displayName, allowedDomain, trustedCurrentStatusUrl } = RESEARCH_CONFIG[carrier];

  return [
    `${displayName}が現在配送を停止している地域を抽出できる？郵便番号は無し。`,
    `調査基準日時（日本標準時・Asia/Tokyo）: ${formatTokyoTime(now)}`,
    `使用できる根拠は ${allowedDomain} またはそのサブドメインの公式ページだけです。`,
    `最初に現在の配送状況を掲載する公式URL ${trustedCurrentStatusUrl} を開いて内容を確認し、現在有効かどうかの判断に使用してください。`,
    "他の公式ページを補助的に確認しても構いませんが、sourceUrlとsourceUrlsには実際に判断に使用したページだけを記載してください。",
    "現在有効な、荷物・郵便物の引受け停止、集荷停止、配達停止、または明示的なサービス停止だけを対象にしてください。",
    "単なる遅延、営業時間短縮、受付締切時刻の変更、すでに解除・終了した過去情報は除外してください。",
    "告知の公開日だけで判断せず、本文と更新情報から調査基準日時にも有効か確認してください。",
    "地域の階層を推測・補完しないでください。areaがある場合はcityも必須です。都道府県全域の場合だけcityをnullにできます。",
    "1件の記述に複数の自治体があり階層を公式記載から確定できる場合は、自治体ごとに分けてください。",
    "sourceUrlは、その制限を直接裏付ける公式URLを設定し、sourceUrlsにも含めてください。",
    "carrierとcheckedAtはサーバー側で設定するため出力しないでください。郵便番号も出力しないでください。",
    "現在有効な停止地域を公式根拠で確認できた場合は determination=active_restrictions_found とし、restrictionsを1件以上返してください。",
    "停止地域が現在ないことを公式根拠で明確に確認できた場合だけ determination=no_active_restrictions とし、restrictionsを空配列で返してください。",
    "有効状態を公式根拠から確定できない場合は determination=insufficient_evidence とし、restrictionsを空配列で返してください。",
    "sourceUrlsには実際に判断に使った公式URLのみを、完全なURLで返してください。",
  ].join("\n");
}

function normalizeOfficialUrl(rawUrl: unknown, allowedDomain: string): string {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("Carrier research validation failed: source URL must be a non-empty string");
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Carrier research validation failed: source URL is invalid");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0
    || url.password.length > 0
    || (hostname !== allowedDomain && !hostname.endsWith(`.${allowedDomain}`))
    || (url.port !== "" && url.port !== "80" && url.port !== "443")
  ) {
    throw new Error("Carrier research validation failed: source URL is not on the allowed official domain");
  }

  url.protocol = "https:";
  url.hostname = hostname;
  url.username = "";
  url.password = "";
  url.hash = "";
  if (url.port === "80" || url.port === "443") url.port = "";
  url.searchParams.sort();
  return url.href;
}

const TRACKING_QUERY_PARAMETERS = new Set([
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "sc_bid",
  "argument",
  "dmai",
  "ttclid",
]);

function officialUrlIdentity(normalizedUrl: string): string {
  const url = new URL(normalizedUrl);
  const trackingParameterNames = [...new Set(
    [...url.searchParams.keys()].filter((name) => {
      const normalizedName = name.toLowerCase();
      return normalizedName.startsWith("utm_")
        || TRACKING_QUERY_PARAMETERS.has(normalizedName);
    }),
  )];

  for (const name of trackingParameterNames) url.searchParams.delete(name);
  url.searchParams.sort();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

function exactOfficialUrlIdentity(normalizedUrl: string): string {
  const url = new URL(normalizedUrl);
  url.searchParams.sort();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

function responseId(data: OpenAIResponse): string {
  if (
    typeof data.id === "string"
    && /^[A-Za-z0-9_-]{1,200}$/.test(data.id)
  ) {
    return data.id;
  }
  return "unavailable";
}

function boundedUrlList(urls: Iterable<string>): string {
  return JSON.stringify([...new Set(urls)].slice(0, 5));
}

function researchUrlMismatch(
  message: string,
  data: OpenAIResponse,
  modelUrls: Iterable<string>,
  evidenceUrls: Iterable<string>,
): Error {
  return new Error(
    `Carrier research validation failed: ${message}; responseId=${responseId(data)}`
      + ` modelUrls=${boundedUrlList(modelUrls)}`
      + ` evidenceUrls=${boundedUrlList(evidenceUrls)}`,
  );
}

function collectResearchEvidence(
  data: OpenAIResponse,
  allowedDomain: string,
): Map<string, string> {
  const rawUrls: unknown[] = [];

  for (const item of outputItems(data)) {
    if (item.type === "web_search_call" && isRecord(item.action)) {
      if (item.action.url !== undefined) rawUrls.push(item.action.url);
      if (Array.isArray(item.action.sources)) {
        for (const source of item.action.sources) {
          if (isRecord(source) && source.url !== undefined) rawUrls.push(source.url);
        }
      }
    }

    for (const content of contentItems(item)) {
      if (!Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (isRecord(annotation) && annotation.type === "url_citation" && annotation.url !== undefined) {
          rawUrls.push(annotation.url);
        }
      }
    }
  }

  const evidence = new Map<string, string>();
  for (const rawUrl of rawUrls) {
    const normalizedUrl = normalizeOfficialUrl(rawUrl, allowedDomain);
    const identity = officialUrlIdentity(normalizedUrl);
    if (!evidence.has(identity)) evidence.set(identity, normalizedUrl);
  }
  return evidence;
}

interface TrustedOfficialSource {
  identity: string;
  url: string;
}

function trustedOfficialSources(
  carrier: ResearchCarrier,
  trustedRestrictionUrls: readonly string[],
): Map<string, TrustedOfficialSource> {
  const {
    allowedDomain,
    trustedCurrentStatusUrl,
  } = RESEARCH_CONFIG[carrier];
  const trustedSources = new Map<string, TrustedOfficialSource>();

  for (const rawUrl of [trustedCurrentStatusUrl, ...trustedRestrictionUrls]) {
    const url = normalizeOfficialUrl(rawUrl, allowedDomain);
    const identity = exactOfficialUrlIdentity(url);
    trustedSources.set(identity, { identity, url });
  }

  return trustedSources;
}

function resolveSupportedOfficialSource(
  normalizedModelUrl: string,
  evidenceUrlsByIdentity: Map<string, string>,
  trustedSourcesByIdentity: Map<string, TrustedOfficialSource>,
): string | undefined {
  const evidenceUrl = evidenceUrlsByIdentity.get(officialUrlIdentity(normalizedModelUrl));
  if (evidenceUrl !== undefined) return evidenceUrl;
  return trustedSourcesByIdentity.get(exactOfficialUrlIdentity(normalizedModelUrl))?.url;
}

function parseResearchOutput(data: OpenAIResponse): ResearchOutput {
  const raw = readOutputText(data).trim();
  if (raw.length === 0) throw new Error("Carrier research failed: completed response had no output text");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Carrier research failed: output text was not valid JSON");
  }

  if (!isRecord(parsed)) throw new Error("Carrier research validation failed: output must be an object");
  requireExactKeys(parsed, ["determination", "restrictions", "sourceUrls"], "output");
  if (
    parsed.determination !== "active_restrictions_found"
    && parsed.determination !== "no_active_restrictions"
    && parsed.determination !== "insufficient_evidence"
  ) {
    throw new Error("Carrier research validation failed: determination is invalid");
  }
  if (!Array.isArray(parsed.restrictions)) {
    throw new Error("Carrier research validation failed: restrictions must be an array");
  }
  if (!Array.isArray(parsed.sourceUrls)) {
    throw new Error("Carrier research validation failed: sourceUrls must be an array");
  }

  return {
    determination: parsed.determination,
    restrictions: parsed.restrictions,
    sourceUrls: parsed.sourceUrls,
  };
}

function requireNullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Carrier research validation failed: restriction ${field} must be a string or null`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeResearchRestriction(
  value: unknown,
  carrier: ResearchCarrier,
  checkedAt: string,
  allowedDomain: string,
  normalizedModelSourceUrls: string[],
  evidenceUrlsByIdentity: Map<string, string>,
  trustedSourcesByIdentity: Map<string, TrustedOfficialSource>,
  responseData: OpenAIResponse,
): DeliveryRestriction {
  if (!isRecord(value)) {
    throw new Error("Carrier research validation failed: every restriction must be an object");
  }
  requireExactKeys(value, [
    "prefecture",
    "city",
    "area",
    "status",
    "services",
    "reason",
    "sourceUrl",
    "sourcePublishedAt",
  ], "restriction");

  if (typeof value.prefecture !== "string" || value.prefecture.trim().length === 0) {
    throw new Error("Carrier research validation failed: restriction prefecture is required");
  }
  const prefecture = value.prefecture.trim();
  const city = requireNullableString(value, "city");
  const area = requireNullableString(value, "area");
  if (area !== null && city === null) {
    throw new Error("Carrier research validation failed: restriction area requires city");
  }
  if (value.status !== "suspended" && value.status !== "partially_suspended") {
    throw new Error("Carrier research validation failed: restriction status is invalid");
  }
  if (!Array.isArray(value.services) || value.services.some((service) => typeof service !== "string" || service.trim().length === 0)) {
    throw new Error("Carrier research validation failed: restriction services must contain only non-empty strings");
  }
  const services = [...new Set(value.services.map((service) => (service as string).trim()))];
  const reason = requireNullableString(value, "reason");
  const sourcePublishedAt = requireNullableString(value, "sourcePublishedAt");
  const modelSourceUrl = normalizeOfficialUrl(value.sourceUrl, allowedDomain);
  const resolvedSourceUrl = resolveSupportedOfficialSource(
    modelSourceUrl,
    evidenceUrlsByIdentity,
    trustedSourcesByIdentity,
  );
  if (resolvedSourceUrl === undefined) {
    throw researchUrlMismatch(
      "restriction source URL is absent from web-search evidence and does not exactly match the trusted current-status URL",
      responseData,
      [modelSourceUrl, ...normalizedModelSourceUrls],
      [...evidenceUrlsByIdentity.values(), ...[...trustedSourcesByIdentity.values()].map(({ url }) => url)],
    );
  }

  return {
    carrier,
    prefecture,
    city,
    area,
    status: value.status,
    services,
    reason,
    sourceUrl: resolvedSourceUrl,
    sourcePublishedAt,
    checkedAt,
  };
}

function hasRefusal(data: OpenAIResponse): boolean {
  return outputItems(data).some((item) => contentItems(item).some((content) => content.type === "refusal"));
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

function completedWebSearchCount(data: OpenAIResponse): number {
  return outputItems(data).filter(
    (item) => item.type === "web_search_call" && item.status === "completed",
  ).length;
}

/**
 * Emits one greppable line per billed call. Reasoning tokens and web_search
 * calls are charged separately from the visible answer, so both are recorded:
 * without this the only place the spend is visible is the invoice.
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
    `searches=${completedWebSearchCount(data)}`,
  ];

  console.info(`[usage] operation=${operation} model=${model} ${fields.join(" ")}`);
}

function completedWebSearchOccurred(data: OpenAIResponse): boolean {
  return completedWebSearchCount(data) > 0;
}

function incompleteReason(data: OpenAIResponse): string | null {
  if (!isRecord(data.incomplete_details)) return null;
  return typeof data.incomplete_details.reason === "string" ? data.incomplete_details.reason : null;
}

export async function researchCarrierRestrictions(
  carrier: ResearchCarrier,
  apiKey: string,
  model: string,
  now = new Date(),
  restrictionUrls: readonly string[] = defaultRestrictionUrls(carrier),
): Promise<CarrierResearchResult> {
  const { allowedDomain } = RESEARCH_CONFIG[carrier];
  const trustedRestrictionUrls = [...new Set(restrictionUrls.map((url) =>
    normalizeOfficialUrl(url, allowedDomain)
  ))];
  const trustedSourcesByIdentity = trustedOfficialSources(carrier, trustedRestrictionUrls);
  formatTokyoTime(now);
  const checkedAt = now.toISOString();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // Reasoning tokens are billed and count against max_output_tokens, so both
      // are bounded here. RESEARCH_MAX_OUTPUT_TOKENS is sized for the reasoning
      // budget of a multi-search run plus the JSON payload; lowering it silently
      // truncates the response (surfaced as an incomplete-response error below).
      reasoning: { effort: "low" },
      max_output_tokens: RESEARCH_MAX_OUTPUT_TOKENS,
      tools: [{
        type: "web_search",
        // "medium" over "high" for cost. "low" is deliberately not used: a
        // weaker search raises the odds of insufficient_evidence, which fails
        // the sync outright.
        search_context_size: "medium",
        filters: { allowed_domains: [allowedDomain] },
      }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      text: {
        format: {
          type: "json_schema",
          name: "carrier_delivery_restrictions",
          strict: true,
          schema: researchOutputSchema(carrier, trustedRestrictionUrls),
        },
      },
      input: researchPrompt(carrier, now),
    }),
  });

  const data = await readJsonResponse(response, `${carrier} carrier research`);
  // Logged before the guards below: a truncated or refused response is billed too.
  logTokenUsage(`${carrier}-research`, model, data);
  if (data.status !== "completed") {
    const reason = incompleteReason(data);
    // reason=max_output_tokens means the answer was cut off rather than wrong;
    // report the configured ceiling so the fix is obvious from the log alone.
    const limit = reason === "max_output_tokens" ? ` max_output_tokens=${RESEARCH_MAX_OUTPUT_TOKENS}` : "";
    throw new Error(
      `${carrier} carrier research failed: response status=${String(data.status ?? "missing")}${reason ? ` reason=${reason}` : ""}${limit}`,
    );
  }
  if (hasRefusal(data)) throw new Error(`${carrier} carrier research failed: model refusal`);
  if (!completedWebSearchOccurred(data)) {
    throw new Error(`${carrier} carrier research failed: no completed web_search_call`);
  }

  const evidenceUrlsByIdentity = collectResearchEvidence(data, allowedDomain);
  const output = parseResearchOutput(data);
  const normalizedModelSourceUrls = [...new Set(
    output.sourceUrls.map((url) => normalizeOfficialUrl(url, allowedDomain)),
  )];

  const supportedModelSourceUrls: string[] = [];
  for (const modelSourceUrl of normalizedModelSourceUrls) {
    const resolvedSourceUrl = resolveSupportedOfficialSource(
      modelSourceUrl,
      evidenceUrlsByIdentity,
      trustedSourcesByIdentity,
    );
    if (resolvedSourceUrl !== undefined) supportedModelSourceUrls.push(resolvedSourceUrl);
  }

  const restrictions = output.restrictions.map((restriction) => normalizeResearchRestriction(
    restriction,
    carrier,
    checkedAt,
    allowedDomain,
    normalizedModelSourceUrls,
    evidenceUrlsByIdentity,
    trustedSourcesByIdentity,
    data,
  ));

  if (output.determination === "insufficient_evidence") {
    if (restrictions.length > 0) {
      throw new Error("Carrier research validation failed: insufficient evidence cannot include restrictions");
    }
    throw new Error(`${carrier} carrier research failed: official evidence was insufficient`);
  }
  if (output.determination === "active_restrictions_found" && restrictions.length === 0) {
    throw new Error("Carrier research validation failed: active determination requires restrictions");
  }
  if (output.determination === "no_active_restrictions" && restrictions.length > 0) {
    throw new Error("Carrier research validation failed: no-active determination requires empty restrictions");
  }

  const resolvedSourceUrls = [...new Set([
    ...restrictions.map(({ sourceUrl }) => sourceUrl),
    ...supportedModelSourceUrls,
  ])];
  if (resolvedSourceUrls.length === 0) {
    throw researchUrlMismatch(
      "no model or restriction source URL is supported by web-search evidence or the trusted current-status URL",
      data,
      normalizedModelSourceUrls,
      [...evidenceUrlsByIdentity.values(), ...[...trustedSourcesByIdentity.values()].map(({ url }) => url)],
    );
  }

  return {
    determination: output.determination,
    restrictions: deduplicateRestrictions(restrictions),
    sourceUrls: resolvedSourceUrls,
  };
}

export async function extractRestrictions(
  source: SourceDocument,
  apiKey: string,
  model: string,
): Promise<DeliveryRestriction[]> {
  const checkedAt = new Date().toISOString();
  const inputText = source.text.slice(0, EXTRACTION_INPUT_CHARACTER_LIMIT);
  if (inputText.length < source.text.length) {
    console.warn(
      `[extract] ${source.carrier} source text truncated for the model:`
        + ` ${source.text.length} chars exceeds the ${EXTRACTION_INPUT_CHARACTER_LIMIT} character cap (${source.url})`,
    );
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // See RESEARCH_MAX_OUTPUT_TOKENS: this ceiling covers reasoning tokens too.
      reasoning: { effort: "low" },
      max_output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      instructions: [
        "You extract Japanese delivery restrictions from official carrier source text.",
        "Return JSON only: an array of currently active delivery suspension records.",
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
        "If area is non-null, city must also be non-null. Never output an area without its municipality.",
        "city may be null only when the restriction clearly applies to the entire prefecture.",
        "When one source row contains multiple municipalities, create separate records when their hierarchy can be determined from the source.",
        "Do not turn a delay-only row into a suspension record just because another section on the page contains suspensions.",
        "status must be suspended or partially_suspended.",
        "services must be an array of affected service/product names; use [] only when the source does not specify them.",
        `carrier must be ${source.carrier}.`,
      ].join("\n"),
      input: `SOURCE URL: ${source.url}\nCHECKED AT: ${checkedAt}\n\n${inputText}`,
    }),
  });

  const data = await readJsonResponse(response, "OpenAI extraction");
  // Logged before the guards below: a truncated or refused response is billed too.
  logTokenUsage(`${source.carrier}-extract`, model, data);
  // A response cut off by max_output_tokens can still carry parseable JSON for
  // the records it managed to emit, which would look like a shorter but valid
  // restriction list. Fail loudly instead: the sync layer treats this as a
  // carrier failure and keeps the existing data.
  // Mirrors the research call site: any status other than completed — failed and
  // in_progress included — must not reach the parser.
  const truncationReason = incompleteReason(data);
  if (data.status !== "completed" || truncationReason !== null) {
    const limit = truncationReason === "max_output_tokens"
      ? ` max_output_tokens=${EXTRACTION_MAX_OUTPUT_TOKENS}`
      : "";
    throw new Error(
      `OpenAI extraction failed: response status=${String(data.status ?? "missing")}`
        + `${truncationReason ? ` reason=${truncationReason}` : ""}${limit}`,
    );
  }

  const raw = readOutputText(data).trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  let parsed: Array<Partial<DeliveryRestriction>>;
  try {
    parsed = JSON.parse(raw) as Array<Partial<DeliveryRestriction>>;
  } catch {
    throw new Error(
      `OpenAI extraction failed: output text was not valid JSON`
        + ` (${raw.length} chars; a cut-off response is the usual cause)`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OpenAI extraction failed: output was not a JSON array of restrictions");
  }

  const normalized = parsed
    .map((item) => normalizeRestriction(source, checkedAt, item))
    .filter(isValidRestriction);

  return deduplicateRestrictions(normalized);
}
