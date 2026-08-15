/**
 * Islands that carriers name as restricted areas, mapped to the municipalities
 * they consist of.
 *
 * This is a curated, hand-audited constant, not something a model or a
 * heuristic may infer. The official postal dataset (KEN_ALL / 郵便番号データ,
 * 日本郵便) has no island column, and not one of its rows carries any of these
 * island names as a town, so an island can only be resolved through the
 * municipalities that make it up. The island → municipality relationships below
 * are the administrative composition of the 奄美群島 as published by 鹿児島県
 * and the municipalities themselves; the only thing that can change them is a
 * municipal merger, and the change has to be made here by hand.
 *
 * Postal-code prefix arithmetic is not an alternative: 沖永良部島 (和泊町・
 * 知名町) and 与論島 (与論町) share the 8919 prefix, so nothing but the
 * municipality separates them.
 *
 * Municipality names are written exactly as KEN_ALL writes them (郡 included),
 * because they are matched against the `city` column verbatim.
 */
export const ISLAND_MUNICIPALITIES: Readonly<Record<string, readonly string[]>> = {
  喜界島: ["大島郡喜界町"],
  徳之島: ["大島郡徳之島町", "大島郡天城町", "大島郡伊仙町"],
  沖永良部島: ["大島郡和泊町", "大島郡知名町"],
  与論島: ["大島郡与論町"],
  奄美大島: ["奄美市", "大島郡大和村", "大島郡宇検村", "大島郡瀬戸内町", "大島郡龍郷町"],
};

/**
 * Municipalities covering every known island named anywhere in `area`.
 *
 * Substring matching rather than equality: sources write 喜界島, 喜界島全域 and
 * 喜界島・徳之島 for the same thing. An unknown area yields an empty list, which
 * the caller treats as "not an island" and falls back from.
 */
export function islandMunicipalities(area: string): string[] {
  const municipalities = new Set<string>();
  for (const [island, cities] of Object.entries(ISLAND_MUNICIPALITIES)) {
    if (!area.includes(island)) continue;
    for (const city of cities) municipalities.add(city);
  }
  return [...municipalities];
}
