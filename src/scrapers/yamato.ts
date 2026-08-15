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

function looksLikeJapaneseYamatoPage(text: string): boolean {
  return ["お荷物", "荷受け", "集荷", "配達", "ヤマト"].some((keyword) => text.includes(keyword));
}

function decodePageBody(buffer: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (looksLikeJapaneseYamatoPage(utf8)) return utf8;

  try {
    const shiftJis = new TextDecoder("shift_jis").decode(buffer);
    if (looksLikeJapaneseYamatoPage(shiftJis)) return shiftJis;
  } catch {
    // Some runtimes only expose UTF-8. In that case keep the UTF-8 result.
  }

  return utf8;
}

function isSuspensionRow(line: string): boolean {
  if (!line.includes("|")) return false;

  return [
    "お預かりを停止",
    "荷受けを停止",
    "集荷・配達業務を停止",
    "集荷・配達を停止",
    "集荷・配達について停止",
  ].some((phrase) => line.includes(phrase));
}

function extractSuspensionRows(text: string): string {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isSuspensionRow);

  if (rows.length === 0) {
    const diagnostic = text
      .split("\n")
      .filter((line) => /停止|荷受け|集荷|配達/.test(line))
      .slice(0, 12)
      .join("\n");

    throw new Error(
      `Yamato suspension rows were not found. Diagnostic excerpt: ${diagnostic.slice(0, 1200)}`,
    );
  }

  return [
    "The following rows are taken from Yamato Transport's current official status page.",
    "Only rows that explicitly state shipment acceptance or pickup/delivery suspension are included.",
    "Columns are separated by |. Preserve the geographical hierarchy written in each row.",
    ...rows,
  ].join("\n");
}

export async function fetchYamatoStatus(): Promise<SourceDocument> {
  const response = await fetch(YAMATO_STATUS_URL, {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });

  if (!response.ok) throw new Error(`Yamato fetch failed: ${response.status}`);

  const buffer = await response.arrayBuffer();
  const html = decodePageBody(buffer);
  const structuredText = htmlToStructuredText(html);

  return {
    carrier: "yamato",
    url: YAMATO_STATUS_URL,
    text: extractSuspensionRows(structuredText),
  };
}
