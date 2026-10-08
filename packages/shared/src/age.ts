// Baby age at capture (docs/plans/step-4.md 2.6, 2.7 step 11; PRD "FR-4 Metadata extraction")
// and the timeline's age groups (docs/plans/step-5.md 2.2; PRD "FR-8 Browsing"). Ages are
// calendar-day differences between the birth date and the local date the photo was taken
// (capture instant shifted by its UTC offset). Pure functions, no zod, browser-safe.

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a `YYYY-MM-DD` calendar date; throws `RangeError` if invalid. */
function epochDay(date: string): number {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new RangeError("date must be YYYY-MM-DD");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError("date must be a real calendar date");
  }
  return Math.round(t / DAY_MS);
}

/**
 * `YYYY-MM-DD` of `at` in a zone with offset `tzOffsetMinutes` (east of UTC positive, e.g.
 * `-420` for UTC-07:00); `null` ⇒ UTC. Throws `RangeError` for an invalid date or offset.
 */
export function localCalendarDate(at: Date, tzOffsetMinutes: number | null): string {
  const t = at.getTime();
  if (Number.isNaN(t)) throw new RangeError("invalid date");
  const offset = tzOffsetMinutes ?? 0;
  if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
    throw new RangeError("tzOffsetMinutes must be an integer in -840..840");
  }
  return new Date(t + offset * 60_000).toISOString().slice(0, 10);
}

/**
 * Calendar days from `birthDate` (`YYYY-MM-DD`) to the local capture date of `takenAt`
 * (`localCalendarDate`). Negative before the birth date (due-date babies, bump photos): stored
 * as is. Example: `ageDays('2025-06-30', new Date('2026-06-14T23:30:00Z'), -420) === 349`.
 */
export function ageDays(birthDate: string, takenAt: Date, tzOffsetMinutes: number | null): number {
  return epochDay(localCalendarDate(takenAt, tzOffsetMinutes)) - epochDay(birthDate);
}

// ---------------------------------------------------------------------------------------------
// Age groups (step 5). One definition for the API summary, the SPA headers/scrubber/alt text and
// the perf seed. The SQL twin `public.age_group(age_days integer)` must return exactly the same
// keys (an integration test compares them over -10..2000):
//
//   ageDays          key                               label
//   null             unknown                           "Just uploaded"   (not ingested yet)
//   < 0              pre                               "Before birth"
//   0 <= d < 84      w{n}, n = floor(d / 7) + 1        "Week n"          (n = 1..12)
//   84 <= d < 730    m{n}, n = floor(d / 30.4375) + 1  "Month n"         (n = 3..24)
//   d >= 730         y{n}, n = floor(d / 365)          "n years"         (n = 2..)
//
// Timeline order is newest first = descending `ageGroupSortValue`: unknown, y.., m24..m3,
// w12..w1, pre.

/** Ages below this many days are grouped by week ("Week 1" .. "Week 12"). */
export const AGE_GROUP_WEEKS_UNTIL_DAYS = 84;
/** Ages below this many days (and at least `AGE_GROUP_WEEKS_UNTIL_DAYS`) are grouped by month. */
export const AGE_GROUP_MONTHS_UNTIL_DAYS = 730;
/** Average month length in days (365.25 / 12); exact in binary floating point. */
export const AGE_MONTH_DAYS = 30.4375;

const DAYS_PER_YEAR = 365;
const AGE_GROUP_KEY_RE = /^(?:unknown|pre|([wmy])([1-9]\d{0,3}))$/;

export type AgeGroupKind = "unknown" | "pre" | "week" | "month" | "year";

/** A parsed age group key: `n` is the week/month/year number, `null` for `unknown`/`pre`. */
export interface AgeGroup {
  readonly kind: AgeGroupKind;
  readonly n: number | null;
}

/**
 * Age group key of a photo (`photos.age_days`): `unknown`, `pre`, `w1`..`w12`, `m3`..`m24`,
 * `y2`... A non-integer is floored; `null` or a non-finite number is `unknown`.
 */
export function ageGroupKey(ageDays: number | null): string {
  if (ageDays === null || !Number.isFinite(ageDays)) return "unknown";
  const d = Math.floor(ageDays);
  if (d < 0) return "pre";
  if (d < AGE_GROUP_WEEKS_UNTIL_DAYS) return `w${Math.floor(d / 7) + 1}`;
  if (d < AGE_GROUP_MONTHS_UNTIL_DAYS) return `m${Math.floor(d / AGE_MONTH_DAYS) + 1}`;
  return `y${Math.floor(d / DAYS_PER_YEAR)}`;
}

/**
 * Parses a key produced by `ageGroupKey` (or the SQL `age_group`); `null` when it is not one
 * (wrong prefix, `w13`, `m2`, `m25`, `y1`, leading zeros...).
 */
export function parseAgeGroupKey(key: string): AgeGroup | null {
  const m = AGE_GROUP_KEY_RE.exec(key);
  if (!m) return null;
  if (key === "unknown") return { kind: "unknown", n: null };
  if (key === "pre") return { kind: "pre", n: null };
  const n = Number(m[2]);
  switch (m[1]) {
    case "w":
      return n <= AGE_GROUP_WEEKS_UNTIL_DAYS / 7 ? { kind: "week", n } : null;
    case "m": {
      const first = Math.floor(AGE_GROUP_WEEKS_UNTIL_DAYS / AGE_MONTH_DAYS) + 1; // 3
      const last = Math.floor((AGE_GROUP_MONTHS_UNTIL_DAYS - 1) / AGE_MONTH_DAYS) + 1; // 24
      return n >= first && n <= last ? { kind: "month", n } : null;
    }
    default:
      return n >= AGE_GROUP_MONTHS_UNTIL_DAYS / DAYS_PER_YEAR ? { kind: "year", n } : null;
  }
}

/** True when `key` is a valid age group key. */
export function isAgeGroupKey(key: string): boolean {
  return parseAgeGroupKey(key) !== null;
}

function parseOrThrow(key: string): AgeGroup {
  const g = parseAgeGroupKey(key);
  if (!g) throw new RangeError(`not an age group key: ${key.slice(0, 20)}`);
  return g;
}

/**
 * English label of an age group key: "Just uploaded", "Before birth", "Week 3", "Month 4",
 * "2 years". The SPA localizes with the i18n key `age.group.<kind>` and `{n}`. Throws
 * `RangeError` for an invalid key.
 */
export function ageGroupLabel(key: string): string {
  const g = parseOrThrow(key);
  switch (g.kind) {
    case "unknown":
      return "Just uploaded";
    case "pre":
      return "Before birth";
    case "week":
      return `Week ${g.n}`;
    case "month":
      return `Month ${g.n}`;
    case "year":
      return `${g.n} years`;
  }
}

/**
 * Sort value of an age group key: the smallest `ageDays` in the group (`w3` = 14, `m3` = 84,
 * `m4` = 92, `y2` = 730), `pre` = -1, `unknown` = +Infinity. The timeline orders groups by
 * this value descending (newest first). `ageGroupKey(ageGroupSortValue(k)) === k` for every key
 * except `pre` and `unknown`. Throws `RangeError` for an invalid key.
 */
export function ageGroupSortValue(key: string): number {
  const g = parseOrThrow(key);
  const n = g.n ?? 0;
  switch (g.kind) {
    case "unknown":
      return Number.POSITIVE_INFINITY;
    case "pre":
      return -1;
    case "week":
      return (n - 1) * 7;
    case "month":
      return Math.max(AGE_GROUP_WEEKS_UNTIL_DAYS, Math.ceil((n - 1) * AGE_MONTH_DAYS));
    case "year":
      return n * DAYS_PER_YEAR;
  }
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Whole months in `days` for display: month `k` starts on day `round(k * AGE_MONTH_DAYS)`
 * (halves rounded down), so a 365-day first birthday is "12 months" rather than the strict
 * `floor(365 / 30.4375) = 11`. Display only: the age groups keep the strict floor.
 */
function displayMonths(days: number): number {
  return Math.floor((days + 0.5) / AGE_MONTH_DAYS);
}

/** First day of display month `months` (inverse of `displayMonths`); always <= the input days. */
function displayMonthStart(months: number): number {
  return Math.ceil(months * AGE_MONTH_DAYS - 0.5);
}

/**
 * Human age for the details panel (English; the SPA wraps it with i18n): "0 days", "3 days",
 * "1 week", "2 weeks 3 days", "11 months 2 weeks", "12 months", "2 years 1 month"; negative ⇒
 * "before birth". Under 84 days: weeks + days (under 7 days just days). Under 730 days:
 * completed months + weeks (0..3, never "4 weeks"). Then years of 365 days + months. Months are
 * `AGE_MONTH_DAYS` long, counted from day `round(k * AGE_MONTH_DAYS)` so birthdays read
 * naturally (365 ⇒ "12 months", 730 ⇒ "2 years"); near a month boundary this can read one
 * month ahead of the strict `ageGroupKey` group (e.g. 365 is in `m12` "Month 12"). Zero parts
 * are omitted. A non-integer is floored; throws `RangeError` for a non-finite number.
 */
export function formatAge(ageDays: number): string {
  if (!Number.isFinite(ageDays)) throw new RangeError("ageDays must be a finite number");
  const d = Math.floor(ageDays);
  if (d < 0) return "before birth";
  if (d < 7) return plural(d, "day");
  if (d < AGE_GROUP_WEEKS_UNTIL_DAYS) {
    const weeks = Math.floor(d / 7);
    const days = d - weeks * 7;
    return days ? `${plural(weeks, "week")} ${plural(days, "day")}` : plural(weeks, "week");
  }
  if (d < AGE_GROUP_MONTHS_UNTIL_DAYS) {
    const months = displayMonths(d);
    const weeks = Math.min(3, Math.floor((d - displayMonthStart(months)) / 7));
    return weeks ? `${plural(months, "month")} ${plural(weeks, "week")}` : plural(months, "month");
  }
  const years = Math.floor(d / DAYS_PER_YEAR);
  const months = displayMonths(d - years * DAYS_PER_YEAR); // 0..11 (364 days -> 11)
  return months ? `${plural(years, "year")} ${plural(months, "month")}` : plural(years, "year");
}
