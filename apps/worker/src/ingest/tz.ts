// Time-zone arithmetic for EXIF wall times (docs/plans/step-4.md 2.7 step 5). EXIF
// `DateTimeOriginal` is a local wall time; when the file has no `OffsetTimeOriginal` the worker
// interprets it in the uploader's profile time zone (`tzHint`, an IANA name in the job payload).
// Pure functions over `Intl` (full ICU ships with the official Node images).

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when the runtime knows `tz` as an IANA zone. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** UTC offset in minutes (east positive) of zone `tz` at instant `utcMs`. */
export function zoneOffsetMinutes(tz: string, utcMs: number): number {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const flooredUtcMs = Math.floor(utcMs / 1000) * 1000;
  return Math.round((asUtc - flooredUtcMs) / 60_000);
}

/**
 * Instant of a wall time in zone `tz`. `wallAsUtcMs` is the wall time's fields read as if they
 * were UTC (`Date.UTC(y, m-1, d, h, mi, s)`). Returns the instant and the zone's offset at it.
 * In a DST gap the later offset wins; in an overlap the earlier instant (first occurrence).
 */
export function wallTimeInZone(
  wallAsUtcMs: number,
  tz: string,
): { utcMs: number; offsetMinutes: number } {
  const guessOffset = zoneOffsetMinutes(tz, wallAsUtcMs);
  let utcMs = wallAsUtcMs - guessOffset * 60_000;
  const actualOffset = zoneOffsetMinutes(tz, utcMs);
  if (actualOffset !== guessOffset) {
    const retry = wallAsUtcMs - actualOffset * 60_000;
    // Accept the second candidate only if it is self-consistent; otherwise keep the first.
    if (zoneOffsetMinutes(tz, retry) === actualOffset) utcMs = retry;
  }
  // Overlap: the wall time may map to two self-consistent instants, one per offset in force
  // around the transition. Which one the guess above lands on depends on the zone's sign (east of
  // UTC it finds the second occurrence), so try every offset in force within a day either side
  // and keep the earliest self-consistent instant. In a gap no candidate is self-consistent, so
  // the gap result above is left untouched.
  const candidateOffsets = new Set([
    zoneOffsetMinutes(tz, wallAsUtcMs - DAY_MS),
    guessOffset,
    zoneOffsetMinutes(tz, wallAsUtcMs + DAY_MS),
  ]);
  for (const offset of candidateOffsets) {
    const candidate = wallAsUtcMs - offset * 60_000;
    if (candidate < utcMs && zoneOffsetMinutes(tz, candidate) === offset) utcMs = candidate;
  }
  return { utcMs, offsetMinutes: zoneOffsetMinutes(tz, utcMs) };
}
