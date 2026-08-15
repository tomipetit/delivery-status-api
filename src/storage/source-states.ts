import type { Carrier } from "../types/restriction";

export interface CarrierSourceState {
  carrier: Carrier;
  fingerprint: string;
  sourceUrls: string[];
  lastCheckedAt: string;
  lastChangedAt: string;
}

export async function getCarrierSourceState(
  db: D1Database,
  carrier: Carrier,
): Promise<CarrierSourceState | null> {
  const row = await db.prepare(`
    SELECT carrier, fingerprint, source_urls_json, last_checked_at, last_changed_at
    FROM carrier_source_states
    WHERE carrier = ?
  `).bind(carrier).first<Record<string, unknown>>();

  if (row === null) return null;

  let sourceUrls: string[] = [];
  try {
    const parsed = JSON.parse(String(row.source_urls_json ?? "[]"));
    if (Array.isArray(parsed)) {
      sourceUrls = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // A corrupt diagnostic field must not disable fingerprint-based caching.
  }

  return {
    carrier: row.carrier as Carrier,
    fingerprint: String(row.fingerprint),
    sourceUrls,
    lastCheckedAt: String(row.last_checked_at),
    lastChangedAt: String(row.last_changed_at),
  };
}

export function upsertCarrierSourceStateStatement(
  db: D1Database,
  carrier: Carrier,
  fingerprint: string,
  sourceUrls: string[],
  checkedAt: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO carrier_source_states (
      carrier, fingerprint, source_urls_json, last_checked_at, last_changed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(carrier) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      source_urls_json = excluded.source_urls_json,
      last_checked_at = excluded.last_checked_at,
      last_changed_at = CASE
        WHEN carrier_source_states.fingerprint = excluded.fingerprint
          THEN carrier_source_states.last_changed_at
        ELSE excluded.last_changed_at
      END,
      updated_at = CURRENT_TIMESTAMP
  `).bind(carrier, fingerprint, JSON.stringify([...new Set(sourceUrls)].sort()), checkedAt, checkedAt);
}

export async function touchCarrierSourceState(
  db: D1Database,
  state: CarrierSourceState,
  checkedAt: string,
  sourceUrls: string[] = state.sourceUrls,
): Promise<void> {
  await upsertCarrierSourceStateStatement(
    db,
    state.carrier,
    state.fingerprint,
    sourceUrls,
    checkedAt,
  ).run();
}
