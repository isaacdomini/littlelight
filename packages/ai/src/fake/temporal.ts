/**
 * Rule-based resolution of temporal phrases for the fake chat model (docs/plans/step-7.md 2.5).
 * The real model does this itself from the system prompt's "Today" and "Birth date"; the fake
 * needs deterministic rules so CI and the golden gate can run without a key. Pure, no I/O.
 *
 * Supported (case-insensitive; numbers as digits or words up to twenty-four):
 * - Ages: "at 6 months", "when she was 6 months old", "6-month-old", "aged 2 years", "at 3 weeks"
 *   ⇒ age centre ± tolerance (months: N × 30.4375 ± 20 days; weeks: N × 7 ± 3; years: N × 365 ± 30).
 * - Comparisons: "at 1, 6 and 12 months" ⇒ one range per age.
 * - Age periods: "month N" ⇒ days ceil((N−1) × 30.4375) .. ceil(N × 30.4375) − 1 (the timeline's
 *   "Month N" group); "week N" ⇒ (N−1) × 7 .. N × 7 − 1; "first week" 0–6; "first month" 0–30;
 *   "first year" 0–364; "newborn" / "as a newborn" 0–28.
 * - Seasons (northern hemisphere): "last summer" ⇒ the most recent Jun 1–Aug 31 that has ended
 *   before today; "this summer" ⇒ this year's; "summer 2025" / "the summer of 2025"; likewise
 *   spring (Mar–May), autumn/fall (Sep–Nov) and winter (Dec 1 – end of Feb).
 * - Calendar: "today", "yesterday", "last week" (the 7 days before today), "this month",
 *   "last month", "this year", "last year", "in 2025"; "in July", "July 2025", "from May 2026"
 *   (a month without a year is its most recent occurrence not after today; a bare "may" needs a
 *   preposition or a year).
 * - Bounds: "before <date>", "after <date>", "since <date>", "until <date>" with an ISO date, a
 *   month (+ year) or a month and day (+ year).
 * Several phrases intersect ("in July 2025 at 4 months"). Matched phrases are removed from
 * `rest`, which the fake uses as the search query.
 */

import { AGE_MONTH_DAYS } from "@littlelight/shared";

export interface TemporalRange {
  dateFrom: string | null;
  dateTo: string | null;
  ageFromDays: number | null;
  ageToDays: number | null;
}

export interface TemporalResult {
  /** `[]` when no phrase matched; several entries for a comparison. */
  ranges: TemporalRange[];
  /** The input with every matched phrase removed (whitespace collapsed). */
  rest: string;
}

export interface TemporalContext {
  /** `YYYY-MM-DD` (the user's local date). */
  today: string;
  /** `YYYY-MM-DD`, or null when unknown. */
  birthDate: string | null;
}

const DAY_MS = 86_400_000;

function dayNum(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fmt(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function ymd(y: number, m: number, d: number): string {
  return fmt(Math.round(Date.UTC(y, m - 1, d) / DAY_MS));
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty-one": 21,
  "twenty-two": 22,
  "twenty-three": 23,
  "twenty-four": 24,
};
const NUM = `(?:\\d{1,3}|${Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join("|")})`;

function toNumber(s: string): number {
  const n = NUMBER_WORDS[s.toLowerCase()];
  return n ?? Number(s);
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
const MONTH_RE = `(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

function monthIndex(s: string): number {
  const k = s.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(k)) + 1;
}

type Unit = "week" | "month" | "year";

function unitOf(s: string): Unit {
  const u = s.toLowerCase();
  return u.startsWith("week") ? "week" : u.startsWith("month") ? "month" : "year";
}

function ageRange(n: number, unit: Unit): [number, number] {
  if (unit === "week") return [Math.max(0, n * 7 - 3), n * 7 + 3];
  if (unit === "year") return [Math.max(0, n * 365 - 30), n * 365 + 30];
  const centre = Math.round(n * AGE_MONTH_DAYS);
  return [Math.max(0, centre - 20), centre + 20];
}

const SEASONS: Record<string, { start: number; end: number }> = {
  spring: { start: 3, end: 5 },
  summer: { start: 6, end: 8 },
  autumn: { start: 9, end: 11 },
  fall: { start: 9, end: 11 },
  winter: { start: 12, end: 2 },
};

/** Season of `year` (winter = Dec of `year` to end of Feb of `year + 1`). */
function seasonRange(season: string, year: number): [string, string] {
  const s = SEASONS[season] as { start: number; end: number };
  if (s.start === 12) return [ymd(year, 12, 1), ymd(year + 1, 2, lastDayOfMonth(year + 1, 2))];
  return [ymd(year, s.start, 1), ymd(year, s.end, lastDayOfMonth(year, s.end))];
}

/** Bound of a "before/after" phrase: `[first day, last day]` of the date, month or day given. */
function boundOf(phrase: string, today: string): [string, string] | null {
  const p = phrase.trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (m) return [p, p];
  const ty = Number(today.slice(0, 4));
  m = new RegExp(`^(${MONTH_RE})(?:\\s+(\\d{1,2}))?(?:,?\\s+(\\d{4}))?$`).exec(p);
  if (!m) return null;
  const mon = monthIndex(m[1] as string);
  const year = m[3] ? Number(m[3]) : ty;
  if (m[2]) {
    const d = Math.min(Number(m[2]), lastDayOfMonth(year, mon));
    const s = ymd(year, mon, d);
    return [s, s];
  }
  return [ymd(year, mon, 1), ymd(year, mon, lastDayOfMonth(year, mon))];
}

/** Resolves the temporal phrases of `text` (see module doc). */
export function resolveTemporal(text: string, ctx: TemporalContext): TemporalResult {
  const today = dayNum(ctx.today);
  const ty = Number(ctx.today.slice(0, 4));
  const tm = Number(ctx.today.slice(5, 7));
  let work = ` ${text} `;
  const base: TemporalRange = { dateFrom: null, dateTo: null, ageFromDays: null, ageToDays: null };
  let comparison: [number, number][] = [];

  const intersectDates = (from: string, to: string) => {
    base.dateFrom = base.dateFrom === null || from > base.dateFrom ? from : base.dateFrom;
    base.dateTo = base.dateTo === null || to < base.dateTo ? to : base.dateTo;
  };
  const intersectAges = (from: number, to: number) => {
    base.ageFromDays = base.ageFromDays === null ? from : Math.max(base.ageFromDays, from);
    base.ageToDays = base.ageToDays === null ? to : Math.min(base.ageToDays, to);
  };
  /** Runs `re` (global, case-insensitive) on the working text; removes each match. */
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | undefined) => {
    work = work.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      return fn(m) === false ? (m[0] as string) : " ";
    });
  };

  // Comparisons first: "at 1, 6 and 12 months".
  take(
    new RegExp(
      `\\b(?:at|when (?:she|he|they) (?:was|were))\\s+((?:${NUM}\\s*,\\s*)*${NUM}\\s*,?\\s*(?:and|&)\\s*${NUM})\\s+(weeks?|months?|years?)(?:\\s+old)?\\b`,
      "gi",
    ),
    (m) => {
      const unit = unitOf(m[2] as string);
      const nums = (m[1] as string).split(/\s*(?:,|\band\b|&)\s*/i).filter(Boolean);
      comparison = nums.map((n) => ageRange(toNumber(n), unit));
      return true;
    },
  );
  // Single ages.
  take(
    new RegExp(
      `\\b(?:at|aged?|when (?:she|he|they) (?:was|were)|around)\\s+(?:about\\s+)?(${NUM})\\s+(weeks?|months?|years?)(?:\\s+old)?\\b`,
      "gi",
    ),
    (m) => {
      const [from, to] = ageRange(toNumber(m[1] as string), unitOf(m[2] as string));
      intersectAges(from, to);
      return true;
    },
  );
  take(new RegExp(`\\b(${NUM})[\\s-](weeks?|months?|years?)[\\s-]old\\b`, "gi"), (m) => {
    const [from, to] = ageRange(toNumber(m[1] as string), unitOf(m[2] as string));
    intersectAges(from, to);
    return true;
  });
  // Age periods.
  take(new RegExp(`\\b(?:in\\s+|during\\s+)?(?:the\\s+)?month\\s+(${NUM})\\b`, "gi"), (m) => {
    const n = toNumber(m[1] as string);
    if (n < 1) return false;
    intersectAges(Math.ceil((n - 1) * AGE_MONTH_DAYS), Math.ceil(n * AGE_MONTH_DAYS) - 1);
    return true;
  });
  take(new RegExp(`\\b(?:in\\s+|during\\s+)?(?:the\\s+)?week\\s+(${NUM})\\b`, "gi"), (m) => {
    const n = toNumber(m[1] as string);
    if (n < 1) return false;
    intersectAges((n - 1) * 7, n * 7 - 1);
    return true;
  });
  take(/\b(?:in\s+|during\s+)?(?:her|his|their|the)?\s*first\s+(week|month|year)\b/gi, (m) => {
    const u = (m[1] as string).toLowerCase();
    intersectAges(0, u === "week" ? 6 : u === "month" ? Math.ceil(AGE_MONTH_DAYS) - 1 : 364);
    return true;
  });
  take(/\b(?:as\s+a\s+)?new-?borns?\b/gi, () => {
    intersectAges(0, 28);
    return true;
  });
  // Bounds.
  take(
    new RegExp(
      `\\b(before|after|since|until)\\s+(\\d{4}-\\d{2}-\\d{2}|${MONTH_RE}(?:\\s+\\d{1,2})?(?:,?\\s+\\d{4})?)\\b`,
      "gi",
    ),
    (m) => {
      const b = boundOf(m[2] as string, ctx.today);
      if (!b) return false;
      const kind = (m[1] as string).toLowerCase();
      if (kind === "before") intersectDates("0001-01-01", fmt(dayNum(b[0]) - 1));
      else if (kind === "until") intersectDates("0001-01-01", b[1]);
      else if (kind === "after") intersectDates(fmt(dayNum(b[1]) + 1), "9999-12-31");
      else intersectDates(b[0], "9999-12-31");
      return true;
    },
  );
  // Seasons.
  take(
    /\b(?:(last|this|past)\s+(spring|summer|autumn|fall|winter)|(?:the\s+)?(spring|summer|autumn|fall|winter)\s+(?:of\s+)?(\d{4}))\b/gi,
    (m) => {
      if (m[4]) {
        const [from, to] = seasonRange((m[3] as string).toLowerCase(), Number(m[4]));
        intersectDates(from, to);
        return true;
      }
      const season = (m[2] as string).toLowerCase();
      if ((m[1] as string).toLowerCase() === "this") {
        // Winter "this" = the winter that started in December of last year when we are in Jan/Feb.
        const year = season === "winter" && tm <= 2 ? ty - 1 : ty;
        const [from, to] = seasonRange(season, year);
        intersectDates(from, to);
        return true;
      }
      // Most recent season that ended before today.
      for (let year = ty; year > ty - 3; year--) {
        const [from, to] = seasonRange(season, year);
        if (dayNum(to) < today) {
          intersectDates(from, to);
          return true;
        }
      }
      return false;
    },
  );
  // Calendar phrases.
  take(/\b(today|yesterday)\b/gi, (m) => {
    const d = (m[1] as string).toLowerCase() === "today" ? today : today - 1;
    intersectDates(fmt(d), fmt(d));
    return true;
  });
  take(/\b(last|past|this)\s+(week|month|year)\b/gi, (m) => {
    const which = (m[1] as string).toLowerCase();
    const unit = (m[2] as string).toLowerCase();
    if (unit === "week") {
      if (which === "this") intersectDates(fmt(today - 6), fmt(today));
      else intersectDates(fmt(today - 7), fmt(today - 1));
    } else if (unit === "month") {
      const [y, mo] = which === "this" ? [ty, tm] : tm === 1 ? [ty - 1, 12] : [ty, tm - 1];
      intersectDates(ymd(y, mo, 1), ymd(y, mo, lastDayOfMonth(y, mo)));
    } else {
      const y = which === "this" ? ty : ty - 1;
      intersectDates(ymd(y, 1, 1), ymd(y, 12, 31));
    }
    return true;
  });
  take(
    new RegExp(`\\b(?:(in|from|during|of)\\s+)?(${MONTH_RE})(?:\\s+(?:of\\s+)?(\\d{4}))?\\b`, "gi"),
    (m) => {
      const word = (m[2] as string).toLowerCase();
      const prep = m[1];
      const year = m[3] ? Number(m[3]) : null;
      // "may" and "mar" are also ordinary words: require a preposition or a year.
      if ((word === "may" || word === "mar" || word === "jun" || word === "jul") && !prep && !year)
        return false;
      const mon = monthIndex(word);
      const y = year ?? (mon > tm ? ty - 1 : ty);
      intersectDates(ymd(y, mon, 1), ymd(y, mon, lastDayOfMonth(y, mon)));
      return true;
    },
  );
  take(/\b(?:in|from|during)\s+((?:19|20)\d{2})\b/gi, (m) => {
    const y = Number(m[1]);
    intersectDates(ymd(y, 1, 1), ymd(y, 12, 31));
    return true;
  });

  const clean = (r: TemporalRange): TemporalRange => ({
    dateFrom: r.dateFrom === "0001-01-01" ? null : r.dateFrom,
    dateTo: r.dateTo === "9999-12-31" ? null : r.dateTo,
    ageFromDays: r.ageFromDays,
    ageToDays: r.ageToDays,
  });
  const hasBase =
    base.dateFrom !== null ||
    base.dateTo !== null ||
    base.ageFromDays !== null ||
    base.ageToDays !== null;
  let ranges: TemporalRange[] = [];
  if (comparison.length > 0) {
    ranges = comparison.map(([from, to]) =>
      clean({
        ...base,
        ageFromDays: base.ageFromDays === null ? from : Math.max(base.ageFromDays, from),
        ageToDays: base.ageToDays === null ? to : Math.min(base.ageToDays, to),
      }),
    );
  } else if (hasBase) {
    ranges = [clean(base)];
  }
  return { ranges, rest: work.replace(/\s+/g, " ").trim() };
}

/** Converts an age range into dates with the birth date (for `get_measurements`, which has no ages). */
export function ageRangeToDates(
  range: TemporalRange,
  birthDate: string | null,
): { dateFrom: string | null; dateTo: string | null } {
  let dateFrom = range.dateFrom;
  let dateTo = range.dateTo;
  if (birthDate !== null) {
    const b = dayNum(birthDate);
    if (range.ageFromDays !== null) {
      const d = fmt(b + range.ageFromDays);
      dateFrom = dateFrom === null || d > dateFrom ? d : dateFrom;
    }
    if (range.ageToDays !== null) {
      const d = fmt(b + range.ageToDays);
      dateTo = dateTo === null || d < dateTo ? d : dateTo;
    }
  }
  return { dateFrom, dateTo };
}
