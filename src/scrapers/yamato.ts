import type { SourceDocument } from "../types/restriction";
import { htmlToStructuredText } from "./html";

const YAMATO_STATUS_URL = "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html";

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

export function extractYamatoStatusText(text: string): string {
  if (!/停止|荷受け/.test(text)) {
    const diagnostic = text
      .split("\n")
      .filter((line) => /停止|荷受け|集荷|配達/.test(line))
      .slice(0, 12)
      .join("\n");

    throw new Error(
      `Yamato status context was not found. Diagnostic excerpt: ${diagnostic.slice(0, 1200)}`,
    );
  }

  const lines = text.split("\n");
  const suspensionSections: string[][] = [];
  let currentSection: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const isMarkedHeading = /^[●■◆◇]/.test(trimmed);
    const isSuspensionHeading = isMarkedHeading && (
      /荷受け.{0,40}停止/.test(trimmed)
      || /集荷\s*[・･／/]\s*配達.{0,30}停止中/.test(trimmed)
    );

    if (isMarkedHeading) {
      if (isSuspensionHeading) {
        currentSection = [line];
        suspensionSections.push(currentSection);
      } else {
        currentSection = null;
      }
      continue;
    }

    if (currentSection !== null) currentSection.push(line);
  }

  if (suspensionSections.length === 0) {
    const diagnostic = lines
      .filter((line) => /停止|荷受け|集荷|配達|遅れ/.test(line))
      .slice(0, 12)
      .join("\n");

    throw new Error(
      `Yamato marked suspension sections were not found. Diagnostic excerpt: ${diagnostic.slice(0, 1200)}`,
    );
  }

  // Yamato writes remarks with decorative brackets and varying particles, so
  // compare against a form without them: 『集荷』・『配達』は行っており and
  // 集荷・配達を行って must both be recognized as the same statement.
  const normalizeRemarks = (row: string): string => row
    .replace(/[『』「」【】《》（）()"'“”‘’]/g, "")
    .replace(/[ \t　]/g, "");

  const statesSuspension = (row: string): boolean => (
    /(?:荷受け|お預かり|お引き取り|集荷|配達|引受け?)[^。\n]{0,20}(?:停止|休止|中止)/.test(row)
  );

  const isOperatingRow = (row: string): boolean => {
    const remarks = normalizeRemarks(row);
    // A row that states its own suspension stays even when it also mentions a
    // shortened acceptance window.
    if (statesSuspension(remarks)) return false;

    return (
      /集荷[・･／/]配達(?:[をはも])?[^。\n]{0,8}(?:行って|実施|継続)/.test(remarks)
      || /受付[^。\n]{0,8}(?:締切|締め切り|時間)[^。\n]{0,8}(?:変更|短縮)/.test(remarks)
    );
  };

  // A section runs until the next marked heading, so page-wide notices, the
  // preamble of the following section, and the page footer trail after the
  // table. Everything after the final table row is dropped.
  const trimAfterLastTableRow = (section: string[]): string[] => {
    for (let index = section.length - 1; index > 0; index -= 1) {
      if (section[index].includes("|")) return section.slice(0, index + 1);
    }

    return section;
  };

  const endsWithCellDelimiter = (line: string): boolean => line.trimEnd().endsWith("|");

  // A whole <tr> rendered on one physical line carries every cell delimiter it
  // needs, so it can be evaluated on its own.
  const isCompleteSingleLineRow = (line: string): boolean => (
    endsWithCellDelimiter(line) && (line.match(/\|/g)?.length ?? 0) >= 2
  );

  const filterOperatingTableRows = (section: string[]): string[] => {
    const result = [section[0]];
    let logicalRow: string[] = [];
    let lastContentLine = "";

    const flushLogicalRow = (): void => {
      if (logicalRow.length === 0) return;
      if (!isOperatingRow(logicalRow.join("\n"))) result.push(...logicalRow);
      logicalRow = [];
      lastContentLine = "";
    };

    for (const line of section.slice(1)) {
      if (line.trim().length === 0) {
        // Yamato puts one cell per line, so </tr> shows up as a blank line
        // after a cell delimiter. A <br><br> inside a cell also produces a
        // blank line, but it follows prose rather than a delimiter.
        if (logicalRow.length > 0 && !endsWithCellDelimiter(lastContentLine)) {
          logicalRow.push(line);
          continue;
        }

        flushLogicalRow();
        result.push(line);
        continue;
      }

      logicalRow.push(line);
      lastContentLine = line;
      if (isCompleteSingleLineRow(line)) flushLogicalRow();
    }
    flushLogicalRow();
    return result;
  };

  // Yamato currently groups the page into marked sections. Keeping complete
  // suspension sections preserves table headers, continuation rows, service
  // columns, and remarks while excluding neighboring delay-only sections.
  const suspensionText = suspensionSections
    .map((section) => filterOperatingTableRows(trimAfterLastTableRow(section))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim())
    .filter(Boolean)
    .join("\n\n");

  return [
    "The following text contains only Yamato Transport sections explicitly headed as acceptance suspension or pickup/delivery suspension.",
    "It includes table headings and adjacent rows so geographical values omitted by rowspan-like formatting retain their context.",
    "Complete suspension-section tables are retained so service limitations and suspension remarks remain available.",
    "A row inside a suspension section is not necessarily suspended: exclude it when its own remarks say pickup/delivery is operating or otherwise continuing.",
    "An acceptance suspension limited to a named service, including airport TA-Q-BIN, is an active restriction and must be included with that service name.",
    "Columns are separated by |. A blank cell may inherit its prefecture or municipality from a preceding row.",
    suspensionText,
  ].join("\n");
}

// A line that is nothing but Yamato's "as of" stamp, e.g. 2026年08月15日　14時現在.
// The separator is the full-width space U+3000 the page actually uses (covered
// by \s), and the numbers are not always zero padded (2026年8月5日 9時現在).
// Anchored to the whole line so a timestamp inside a table row — which always
// carries a "|" cell delimiter — is never stripped: that one would be real
// content moving.
const YAMATO_AS_OF_LINE = /^\s*\d{4}年\s*\d{1,2}月\s*\d{1,2}日\s*\d{1,2}時現在\s*$/;

/**
 * The hash input for change detection, which deliberately differs from the text
 * sent to the model. Yamato restamps its "…時現在" line every hour even when the
 * table below it is untouched, so hashing the raw text makes every run look
 * changed and re-triggers a paid extraction daily. The model still receives the
 * timestamp (it needs it to judge currency); only the fingerprint drops it.
 */
export function yamatoFingerprintText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !YAMATO_AS_OF_LINE.test(line))
    .join("\n");
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
    text: extractYamatoStatusText(structuredText),
  };
}
