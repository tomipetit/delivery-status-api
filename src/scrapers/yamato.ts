import type { SourceDocument } from "../types/restriction";

const YAMATO_STATUS_URL = "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html";

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToStructuredText(html: string): string {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:h1|h2|h3|h4|p|div|section|article|ul|ol)>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .replace(/[\t\r]+/g, " ")
    .replace(/ *\| */g, " | ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSection(text: string, start: string, endCandidates: string[]): string | null {
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return null;

  const contentStart = startIndex + start.length;
  const endIndexes = endCandidates
    .map((candidate) => text.indexOf(candidate, contentStart))
    .filter((index) => index >= 0);
  const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : text.length;

  return `${start}\n${text.slice(contentStart, endIndex).trim()}`;
}

function extractSuspensionSections(text: string): string {
  const sections = [
    extractSection(text, "下記地域のお荷物について、荷受けを停止しております", [
      "お問い合わせは",
      "営業所の営業状況について",
      "集配状況について",
    ]),
    extractSection(text, "集荷・配達停止中地域", [
      "お問い合わせは",
      "©",
    ]),
  ].filter((section): section is string => Boolean(section));

  if (sections.length === 0) {
    throw new Error("Yamato suspension sections were not found");
  }

  return sections.join("\n\n---\n\n");
}

export async function fetchYamatoStatus(): Promise<SourceDocument> {
  const response = await fetch(YAMATO_STATUS_URL, {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });

  if (!response.ok) throw new Error(`Yamato fetch failed: ${response.status}`);

  const html = await response.text();
  const structuredText = htmlToStructuredText(html);

  return {
    carrier: "yamato",
    url: YAMATO_STATUS_URL,
    text: extractSuspensionSections(structuredText),
  };
}
