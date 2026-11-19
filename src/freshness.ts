import type { CarrierSyncWarning } from "./sync";
import type { Carrier } from "./types/restriction";

export const CARRIERS: readonly Carrier[] = ["yamato", "sagawa", "japan_post"];

/**
 * How old a carrier's last completed check may be before the report flags it.
 *
 * The sync runs once a day, so one failed run leaves a 24-hour-old check and
 * already shows up as a failure. 36 hours flags the second consecutive day
 * without a successful check, with slack for the cron starting a few seconds
 * earlier or later than the day before.
 */
export const STALE_AFTER_HOURS = 36;

export interface CarrierFreshness {
  carrier: Carrier;
  /** ISO timestamp of the last completed check, or null when there has been none. */
  lastCheckedAt: string | null;
}

export function carrierFreshness(lastChecked: Partial<Record<Carrier, string>>): CarrierFreshness[] {
  return CARRIERS.map((carrier) => ({ carrier, lastCheckedAt: lastChecked[carrier] ?? null }));
}

/** "11/19 09:00" in Tokyo time; the report reader is in Japan. */
export function formatTokyoDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

/** A warning for every carrier whose data has not been confirmed for too long. */
export function staleCarrierWarnings(freshness: readonly CarrierFreshness[], now: Date): CarrierSyncWarning[] {
  return freshness.flatMap(({ carrier, lastCheckedAt }): CarrierSyncWarning[] => {
    if (lastCheckedAt === null) {
      return [{ carrier, kind: "stale", message: "一度も確認できていません。" }];
    }
    const checkedAt = new Date(lastCheckedAt).getTime();
    if (Number.isNaN(checkedAt)) return [];
    const hours = (now.getTime() - checkedAt) / 3_600_000;
    if (hours < STALE_AFTER_HOURS) return [];
    return [{
      carrier,
      kind: "stale",
      message: `最後に確認できたのは ${formatTokyoDateTime(lastCheckedAt)}（約${Math.floor(hours / 24)}日前）で、データが古いままです。`,
    }];
  });
}
