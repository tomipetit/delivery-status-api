import type { Carrier, DeliveryRestriction } from "../types/restriction";

export interface CarrierSourceArticle {
  carrier: Carrier;
  sourceUrl: string;
  fingerprint: string;
  title: string;
  sourceUpdatedAt: string | null;
  restrictions: DeliveryRestriction[];
  extractorVersion: string;
  lastSeenAt: string;
}

export async function listCarrierSourceArticles(
  db: D1Database,
  carrier: Carrier,
): Promise<CarrierSourceArticle[]> {
  const { results } = await db.prepare(`
    SELECT carrier, source_url, fingerprint, title, source_updated_at,
           restrictions_json, extractor_version, last_seen_at
    FROM carrier_source_articles
    WHERE carrier = ?
    ORDER BY source_url
  `).bind(carrier).all<Record<string, unknown>>();

  return results.map((row) => {
    let restrictions: DeliveryRestriction[];
    try {
      const parsed = JSON.parse(String(row.restrictions_json ?? "[]"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      restrictions = parsed as DeliveryRestriction[];
    } catch {
      throw new Error(`Invalid cached restrictions JSON for ${String(row.source_url)}`);
    }

    return {
      carrier: row.carrier as Carrier,
      sourceUrl: String(row.source_url),
      fingerprint: String(row.fingerprint),
      title: String(row.title),
      sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
      restrictions,
      extractorVersion: String(row.extractor_version),
      lastSeenAt: String(row.last_seen_at),
    };
  });
}

export function replaceCarrierSourceArticleStatements(
  db: D1Database,
  carrier: Carrier,
  articles: CarrierSourceArticle[],
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM carrier_source_articles WHERE carrier = ?").bind(carrier),
    ...articles.map((article) => db.prepare(`
      INSERT INTO carrier_source_articles (
        carrier, source_url, fingerprint, title, source_updated_at,
        restrictions_json, extractor_version, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      article.carrier,
      article.sourceUrl,
      article.fingerprint,
      article.title,
      article.sourceUpdatedAt,
      JSON.stringify(article.restrictions),
      article.extractorVersion,
      article.lastSeenAt,
    )),
  ];
}
