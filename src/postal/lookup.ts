import type { DeliveryRestriction, PostalCodeLevel } from "../types/restriction";
import { islandMunicipalities } from "./islands";

export interface PostalCodeResolution {
  codes: string[];
  level: PostalCodeLevel | null;
}

interface MunicipalityRow {
  postal_code: string;
  town: string;
}

/**
 * Per-run cache of "every KEN_ALL row of one municipality". A carrier listing
 * usually names the same municipality on several consecutive rows, so this
 * keeps one sync to one query per municipality.
 */
export type MunicipalityRowCache = Map<string, MunicipalityRow[]>;

export function createMunicipalityRowCache(): MunicipalityRowCache {
  return new Map();
}

/**
 * The area fragments a source line actually names.
 *
 * Parenthesised groups are dropped first: in
 * `宝立町（大町泥木・大町・二艘丹）・若山町（白滝・南山・洲巻）` the names inside
 * the brackets are sub-localities that KEN_ALL does not carry separately, so
 * keeping them would produce fragments that match nothing while hiding the two
 * town names that do match. What is left is split on the separators the sources
 * use interchangeably.
 */
export function areaFragments(area: string): string[] {
  let stripped = area;
  // Applied repeatedly so nested groups collapse from the inside out.
  for (let pass = 0; pass < 5; pass += 1) {
    const next = stripped.replace(/[（(][^（）()]*[）)]/g, "");
    if (next === stripped) break;
    stripped = next;
  }

  return stripped
    .split(/[・,、]/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/**
 * Codes of the rows whose town matches one of the fragments.
 *
 * Matching runs in both directions on purpose. A source may name a shorter unit
 * than KEN_ALL (`門前町西円山` vs `門前町西円山ハ`) or a longer one
 * (`宝立町大町泥木` vs `宝立町大町`), and both are the same place.
 */
function matchingTownCodes(rows: MunicipalityRow[], fragments: string[]): string[] {
  const codes = new Set<string>();
  for (const row of rows) {
    const matched = fragments.some(
      (fragment) => row.town.startsWith(fragment) || fragment.startsWith(row.town),
    );
    if (matched) codes.add(row.postal_code);
  }
  return [...codes].sort();
}

async function loadMunicipality(
  db: D1Database,
  prefecture: string,
  city: string,
  cache: MunicipalityRowCache,
): Promise<MunicipalityRow[]> {
  const key = `${prefecture}|${city}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const { results } = await db.prepare(`
    SELECT postal_code, town FROM postal_codes WHERE prefecture = ? AND city = ?
  `).bind(prefecture, city).all<MunicipalityRow>();

  const rows = results.map((row) => ({
    postal_code: String(row.postal_code),
    town: String(row.town ?? ""),
  }));
  cache.set(key, rows);
  return rows;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Postal codes for one restriction, at the tightest level the source supports.
 *
 * Attempts, in order: the named towns of a municipality, the whole
 * municipality, the municipalities of a named island, and finally the
 * prefecture. Every step down is a widening, never a guess: a fallback only
 * ever reports an area at least as large as the one the source named.
 *
 * Nothing here may fail a sync. Postal codes are an enrichment, and losing them
 * must not cost the restriction itself, so a storage failure or malformed input
 * returns `{ codes: [], level: null }` instead of throwing.
 */
export async function resolvePostalCodes(
  db: D1Database,
  restriction: Pick<DeliveryRestriction, "prefecture" | "city" | "area">,
  cache: MunicipalityRowCache = createMunicipalityRowCache(),
): Promise<PostalCodeResolution> {
  try {
    const prefecture = nonEmpty(restriction.prefecture);
    if (prefecture === null) return { codes: [], level: null };
    const city = nonEmpty(restriction.city);
    const area = nonEmpty(restriction.area);

    if (city !== null) {
      const rows = await loadMunicipality(db, prefecture, city, cache);
      if (rows.length > 0) {
        if (area !== null) {
          const codes = matchingTownCodes(rows, areaFragments(area));
          if (codes.length > 0) return { codes, level: "town" };
        }
        // Either no area was named, or nothing in it matched a KEN_ALL town.
        // The whole municipality is then the tightest truthful answer; guessing
        // which towns were meant would be worse than being one level coarser.
        return { codes: [...new Set(rows.map((row) => row.postal_code))].sort(), level: "city" };
      }
    }

    if (city === null && area !== null) {
      // An island is named without a municipality (`鹿児島県 / null / 喜界島`).
      // It resolves through the municipalities it consists of, so the result is
      // whole municipalities and is reported as such.
      const codes = new Set<string>();
      for (const municipality of islandMunicipalities(area)) {
        for (const row of await loadMunicipality(db, prefecture, municipality, cache)) {
          codes.add(row.postal_code);
        }
      }
      if (codes.size > 0) return { codes: [...codes].sort(), level: "city" };
    }

    // Prefecture level is reported with an empty list on purpose. Enumerating a
    // whole prefecture adds nothing the `prefecture` field does not already
    // carry — 沖縄県 alone is 804 codes, and a large prefecture runs into
    // thousands — so the level says "everywhere in this prefecture" and the
    // list stays empty. Town and city levels are enumerated in full.
    return { codes: [], level: "prefecture" };
  } catch (reason) {
    console.warn(
      `[postal] lookup failed for ${restriction.prefecture}/${restriction.city ?? "-"}/${restriction.area ?? "-"}: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    return { codes: [], level: null };
  }
}
