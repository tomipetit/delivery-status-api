import type { Carrier, DeliveryRestriction } from "../types/restriction";

export async function replaceCarrierRestrictions(
  db: D1Database,
  carrier: Carrier,
  restrictions: DeliveryRestriction[],
): Promise<void> {
  const statements = [
    db.prepare("DELETE FROM delivery_restrictions WHERE carrier = ?").bind(carrier),
    ...restrictions.map((item) =>
      db.prepare(`
        INSERT INTO delivery_restrictions (
          carrier, prefecture, city, area, status, services_json, reason,
          source_url, source_published_at, checked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        item.carrier,
        item.prefecture,
        item.city,
        item.area,
        item.status,
        JSON.stringify(item.services),
        item.reason,
        item.sourceUrl,
        item.sourcePublishedAt,
        item.checkedAt,
      ),
    ),
  ];

  await db.batch(statements);
}

export async function listRestrictions(
  db: D1Database,
  carrier?: Carrier,
): Promise<DeliveryRestriction[]> {
  const query = carrier
    ? db.prepare("SELECT * FROM delivery_restrictions WHERE carrier = ? ORDER BY prefecture, city, area").bind(carrier)
    : db.prepare("SELECT * FROM delivery_restrictions ORDER BY carrier, prefecture, city, area");

  const { results } = await query.all<Record<string, unknown>>();

  return results.map((row) => ({
    carrier: row.carrier as Carrier,
    prefecture: String(row.prefecture),
    city: row.city ? String(row.city) : null,
    area: row.area ? String(row.area) : null,
    status: row.status === "partially_suspended" ? "partially_suspended" : "suspended",
    services: JSON.parse(String(row.services_json ?? "[]")) as string[],
    reason: row.reason ? String(row.reason) : null,
    sourceUrl: String(row.source_url),
    sourcePublishedAt: row.source_published_at ? String(row.source_published_at) : null,
    checkedAt: String(row.checked_at),
  }));
}
