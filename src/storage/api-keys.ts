import { sha256Hex } from "../source-fingerprint";
import { tokyoCalendarDayStartIso } from "../tokyo-day";

export interface ApiKeyIdentity {
  id: number;
  name: string;
}

/**
 * Resolves a presented key to the client it identifies, or null.
 *
 * The plaintext key is never stored: rows hold only sha256Hex(key), and the
 * lookup hashes the presented value and matches on the UNIQUE key_hash column.
 * Because the comparison happens as an indexed equality inside SQLite, no
 * secret is compared byte by byte in JS — which also removes the timing-unsafe
 * `===` that the single shared key used.
 */
export async function findActiveApiKey(
  db: D1Database,
  presentedKey: string,
): Promise<ApiKeyIdentity | null> {
  const keyHash = await sha256Hex(presentedKey);
  const row = await db.prepare(`
    SELECT id, name
    FROM api_keys
    WHERE key_hash = ? AND revoked_at IS NULL
  `).bind(keyHash).first<Record<string, unknown>>();

  if (row === null) return null;

  return {
    id: Number(row.id),
    name: String(row.name),
  };
}

/**
 * Records that a key was used, at most once per Tokyo calendar day.
 *
 * last_used_at is diagnostic, not accounting, so it is not worth a write on
 * every request. The guard lives in the WHERE clause: the statement changes a
 * row only when nothing has been recorded yet or the stored timestamp predates
 * the current Tokyo day, so a busy key costs one row write per day no matter
 * how many requests it makes. Stored timestamps are UTC ISO-8601, which sorts
 * chronologically, so the comparison is a plain string comparison in SQLite.
 */
export async function touchApiKeyUsage(db: D1Database, id: number, at: Date): Promise<void> {
  await db.prepare(`
    UPDATE api_keys
    SET last_used_at = ?
    WHERE id = ?
      AND (last_used_at IS NULL OR last_used_at < ?)
  `).bind(at.toISOString(), id, tokyoCalendarDayStartIso(at)).run();
}
