import { tokyoCalendarDate } from "../tokyo-day";
import { parseKenAllCsv, type PostalCodeRecord } from "./ken-all";
import { readZipCsvText } from "./zip";

/**
 * Monthly postal-code refresh.
 *
 * The full dataset is loaded once from `scripts/postal-codes.mjs`; what runs in
 * the Worker is only the monthly difference. 日本郵便 publishes it in the same
 * directory and the same columns as the full file, as `utf_add_YYMM.zip` and
 * `utf_del_YYMM.zip` — four to six rows, a few hundred bytes zipped — which is
 * what makes applying it from a Worker reasonable at all.
 *
 * Note the host path: the older `zipcode/dl/utf/zip/...` URL now 404s.
 */
export const KEN_ALL_DOWNLOAD_BASE =
  "https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/";

const REQUEST_HEADERS = { "user-agent": "delivery-status-api/0.1" };

/** How many statements go into one D1 batch. The diffs are tiny; this is a cap, not a target. */
const BATCH_SIZE = 50;

export interface PostalRefreshResult {
  yymm: string;
  deleted: number;
  added: number;
  /** Archives the site does not have for this month. Normal, not a failure. */
  missing: string[];
}

/** `utf_add_2607.zip` / `utf_del_2607.zip` for the Tokyo calendar month of `now`. */
export function monthlyArchiveNames(now: Date): { yymm: string; add: string; del: string } {
  const [year, month] = tokyoCalendarDate(now).split("-");
  const yymm = `${year.slice(2)}${month}`;
  return { yymm, add: `utf_add_${yymm}.zip`, del: `utf_del_${yymm}.zip` };
}

/**
 * Records of one monthly archive, or null when the site has no such file.
 *
 * A 404 is the ordinary case early in a month, or in a month with no changes at
 * all, and must be a no-op. Any other failure throws so the caller can log it.
 */
async function fetchMonthlyRecords(fileName: string): Promise<PostalCodeRecord[] | null> {
  const response = await fetch(`${KEN_ALL_DOWNLOAD_BASE}${fileName}`, { headers: REQUEST_HEADERS });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${fileName} fetch failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseKenAllCsv(await readZipCsvText(bytes));
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += BATCH_SIZE) {
    await db.batch(statements.slice(index, index + BATCH_SIZE));
  }
}

function deleteStatement(db: D1Database, record: PostalCodeRecord): D1PreparedStatement {
  // Deleted by the full tuple rather than by code alone: one postal code can
  // cover several town rows, and a deletion only ever retires one of them.
  return db.prepare(`
    DELETE FROM postal_codes
    WHERE postal_code = ? AND prefecture = ? AND city = ? AND town = ?
  `).bind(record.postalCode, record.prefecture, record.city, record.town);
}

/**
 * Applies this month's deletions and then its additions.
 *
 * Additions delete their own tuple first, so re-running a month — a retry, or a
 * second scheduled run — cannot duplicate rows.
 */
export async function refreshPostalCodes(
  db: D1Database,
  now: Date = new Date(),
): Promise<PostalRefreshResult> {
  const { yymm, add, del } = monthlyArchiveNames(now);
  const missing: string[] = [];

  const removals = await fetchMonthlyRecords(del);
  if (removals === null) missing.push(del);
  const additions = await fetchMonthlyRecords(add);
  if (additions === null) missing.push(add);

  // Deletions first: a record that moves between municipalities appears in both
  // files, and applying them the other way round would delete the new row.
  await runBatches(db, (removals ?? []).map((record) => deleteStatement(db, record)));

  await runBatches(db, (additions ?? []).flatMap((record) => [
    deleteStatement(db, record),
    db.prepare(`
      INSERT INTO postal_codes (postal_code, prefecture, city, town) VALUES (?, ?, ?, ?)
    `).bind(record.postalCode, record.prefecture, record.city, record.town),
  ]));

  return { yymm, deleted: removals?.length ?? 0, added: additions?.length ?? 0, missing };
}
