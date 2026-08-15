/**
 * Calendar-day helpers pinned to Asia/Tokyo.
 *
 * Both the sync scheduler ("did this carrier already get checked today?") and
 * API key usage bookkeeping ("was this key already recorded today?") need the
 * same notion of a day, so the definition lives here instead of being copied.
 */

export function tokyoCalendarDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

/**
 * The instant at which the Tokyo calendar day containing `value` began, as a
 * UTC ISO-8601 string. Stored timestamps are UTC ISO-8601, so callers can
 * compare against this lexicographically — including inside SQL.
 */
export function tokyoCalendarDayStartIso(value: Date): string {
  return new Date(`${tokyoCalendarDate(value)}T00:00:00+09:00`).toISOString();
}

export function checkedToday(lastCheckedAt: string, now: Date): boolean {
  const previous = new Date(lastCheckedAt);
  return Number.isFinite(previous.getTime())
    && tokyoCalendarDate(previous) === tokyoCalendarDate(now);
}
