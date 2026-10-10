import { AGE_MONTH_DAYS, ageDays, type Measurement } from "@tinyglow/shared";
import { ageText } from "../../lib/age";

/** `YYYY-MM-DD` of an instant in an IANA zone (falls back to UTC for an unknown zone). */
export function localDateIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Age in days of a baby at an instant, using the calendar date in `timeZone`. */
export function ageDaysIn(birthDate: string, at: Date, timeZone: string): number {
  // Convert the local calendar date back into a UTC instant so `ageDays` sees the same day.
  const local = localDateIn(at, timeZone);
  return ageDays(birthDate, new Date(`${local}T12:00:00Z`), 0);
}

/** Measurements are stored at a fixed noon-UTC instant for the chosen date; show that date. */
export function measurementDate(m: Pick<Measurement, "measuredAt">): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(m.measuredAt),
  );
}

export function measurementAgeDays(birthDate: string, m: Pick<Measurement, "measuredAt">): number {
  return ageDays(birthDate, new Date(m.measuredAt), 0);
}

export function measurementAgeText(birthDate: string, m: Pick<Measurement, "measuredAt">): string {
  return ageText(measurementAgeDays(birthDate, m));
}

export const ageMonths = (days: number): number => days / AGE_MONTH_DAYS;
