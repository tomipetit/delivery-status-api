export type Carrier = "yamato" | "sagawa" | "japan_post";

export type RestrictionStatus = "suspended" | "partially_suspended";

export interface DeliveryRestriction {
  carrier: Carrier;
  prefecture: string;
  city: string | null;
  area: string | null;
  status: RestrictionStatus;
  services: string[];
  reason: string | null;
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
