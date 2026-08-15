export type Carrier = "yamato" | "sagawa" | "japan_post";

export type RestrictionStatus = "suspended" | "partially_suspended";

/**
 * How precisely the attached postal codes cover the restricted area.
 *
 * - `town`: the codes of the town(s) the source named inside a municipality.
 * - `city`: every code of the whole municipality — or, for an island, of the
 *   municipalities that make it up.
 * - `prefecture`: the restriction is prefecture-wide; no codes are listed.
 */
export type PostalCodeLevel = "town" | "city" | "prefecture";

export interface DeliveryRestriction {
  carrier: Carrier;
  prefecture: string;
  city: string | null;
  area: string | null;
  status: RestrictionStatus;
  services: string[];
  reason: string | null;
  /**
   * Seven-digit postal codes covering the restricted area, looked up in the
   * official KEN_ALL dataset. Never produced by the extraction model.
   */
  postalCodes: string[];
  /** Granularity of `postalCodes`; null when no lookup could be made at all. */
  postalCodeLevel: PostalCodeLevel | null;
  sourceUrl: string;
  sourcePublishedAt: string | null;
  checkedAt: string;
}

export interface SourceDocument {
  carrier: Carrier;
  url: string;
  title?: string;
  text: string;
  publishedAt?: string | null;
}
