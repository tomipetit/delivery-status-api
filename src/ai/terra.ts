import type { DeliveryRestriction, SourceDocument } from "../types/restriction";

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

function readOutputText(data: OpenAIResponse): string {
  if (data.output_text) return data.output_text;

  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? "")
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

function deduplicateRestrictions(items: DeliveryRestriction[]): DeliveryRestriction[] {
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

export async function extractRestrictions(
  source: SourceDocument,
  apiKey: string,
  model: string,
): Promise<DeliveryRestriction[]> {
  const checkedAt = new Date().toISOString();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        "You extract Japanese delivery restrictions from official carrier source text.",
        "Return JSON only: an array of currently active delivery suspension records.",
        "Include pickup suspension, acceptance suspension, delivery suspension, and explicitly restricted service availability.",
        "Exclude mere delays, shortened business hours, shortened pickup cut-off times, and records explicitly saying pickup/delivery is still operating.",
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
      input: `SOURCE URL: ${source.url}\nCHECKED AT: ${checkedAt}\n\n${source.text.slice(0, 120000)}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI extraction failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const raw = readOutputText(data).trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(raw) as Array<Partial<DeliveryRestriction>>;

  const normalized = parsed
    .map((item) => normalizeRestriction(source, checkedAt, item))
    .filter(isValidRestriction);

  return deduplicateRestrictions(normalized);
}
