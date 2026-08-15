/**
 * KEN_ALL CSV parsing.
 *
 * The published columns are:
 *   0 全国地方公共団体コード, 1 旧郵便番号, 2 郵便番号(7桁),
 *   3 都道府県カナ, 4 市区町村カナ, 5 町域カナ,
 *   6 都道府県, 7 市区町村, 8 町域, then flag columns.
 *
 * Only 2, 6, 7 and 8 are stored: the lookup matches Japanese names and never
 * the kana or the flags. The monthly `utf_add_YYMM` / `utf_del_YYMM` diffs use
 * the same columns, so they parse through here too.
 */

export interface PostalCodeRecord {
  postalCode: string;
  prefecture: string;
  city: string;
  town: string;
}

const POSTAL_CODE_INDEX = 2;
const PREFECTURE_INDEX = 6;
const CITY_INDEX = 7;
const TOWN_INDEX = 8;

/** Fields are quoted; a doubled quote inside a quoted field is one quote. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    if (started || row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }

  if (started || field.length > 0 || row.length > 0) endRow();
  return rows.filter((entry) => entry.some((value) => value.length > 0));
}

/**
 * Records of a KEN_ALL CSV. Rows that do not carry a seven-digit code and a
 * prefecture, city and town are skipped rather than stored: a partial row would
 * only ever widen a later lookup with a name that matches nothing.
 */
export function parseKenAllCsv(text: string): PostalCodeRecord[] {
  const records: PostalCodeRecord[] = [];
  for (const row of parseCsvRows(text)) {
    if (row.length <= TOWN_INDEX) continue;
    const postalCode = row[POSTAL_CODE_INDEX].trim();
    const prefecture = row[PREFECTURE_INDEX].trim();
    const city = row[CITY_INDEX].trim();
    const town = row[TOWN_INDEX].trim();
    if (!/^\d{7}$/.test(postalCode)) continue;
    if (prefecture.length === 0 || city.length === 0 || town.length === 0) continue;
    records.push({ postalCode, prefecture, city, town });
  }
  return records;
}
