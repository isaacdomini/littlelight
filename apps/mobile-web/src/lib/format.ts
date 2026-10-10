// One place for number formatting so every count in the app shows the same separators.
// The app ships English only (see i18n/en.ts); when more locales arrive this is the seam.
const LOCALE = "en";
const counts = new Intl.NumberFormat(LOCALE);

/** 1240 -> "1,240". */
export function formatCount(n: number): string {
  return counts.format(n);
}
