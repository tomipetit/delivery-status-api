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
        "Exclude mere delays unless pickup, acceptance, or delivery is stopped/restricted.",
        "Do not invent locations. Preserve municipality and area names from the source.",
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

  return parsed.map((item) => ({
    carrier: source.carrier,
    prefecture: String(item.prefecture ?? ""),
    city: item.city ? String(item.city) : null,
    area: item.area ? String(item.area) : null,
    status: item.status === "partially_suspended" ? "partially_suspended" : "suspended",
    services: Array.isArray(item.services) ? item.services.map(String) : [],
    reason: item.reason ? String(item.reason) : null,
    sourceUrl: source.url,
    sourcePublishedAt: source.publishedAt ?? null,
    checkedAt,
  })).filter((item) => item.prefecture.length > 0);
}
