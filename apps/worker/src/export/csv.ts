// RFC 4180 CSV for the export (docs/plans/review-fixes.md 2.3): UTF-8 with a BOM (so spreadsheet
// apps detect the encoding), CRLF line endings, a field is quoted when it contains a quote, comma,
// CR or LF (quotes doubled). Free-text cells that a spreadsheet would run as a formula (leading
// `=`, `+`, `-`, `@`, tab or CR) get a leading apostrophe (OWASP "CSV injection"); numbers are
// never touched. `photos.json` keeps the exact text.

export const CSV_BOM = "﻿";
export const CSV_EOL = "\r\n";

/** A cell value: text (formula-guarded), a number/boolean (as is) or empty. */
export type CsvValue = string | number | boolean | null | undefined;

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell. Strings are formula-guarded and quoted when needed; null/undefined are empty. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** One record terminated by CRLF. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(",") + CSV_EOL;
}

/** Header row (column names are fixed identifiers: never guarded or quoted). */
export function csvHeader(columns: readonly string[]): string {
  return columns.join(",") + CSV_EOL;
}
