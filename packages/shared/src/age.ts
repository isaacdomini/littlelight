// Baby age at capture (docs/plans/step-4.md 2.6, 2.7 step 11; PRD "FR-4 Metadata extraction").
// Ages are calendar-day differences between the birth date and the local date the photo was
// taken (capture instant shifted by its UTC offset). Weeks/months formatting is step 5.

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
