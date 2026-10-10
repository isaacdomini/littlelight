import { type AgeGroupKind, formatAge, parseAgeGroupKey } from "@tinyglow/shared";
import { t } from "../i18n";

/** Localized label of an age group key (`w3`, `m4`, `y2`, `pre`, `unknown`); falls back to the key. */
export function ageGroupText(key: string): string {
  const g = parseAgeGroupKey(key);
  if (!g) return key;
  const kind: AgeGroupKind = g.kind;
  return t(`age.group.${kind}`, { n: g.n ?? 0 });
}

/** Human age for a photo ("2 weeks 3 days"); null age ⇒ "age unknown", negative ⇒ "before birth". */
export function ageText(ageDays: number | null | undefined): string {
  if (ageDays === null || ageDays === undefined || !Number.isFinite(ageDays)) {
    return t("age.unknown");
  }
  return ageDays < 0 ? t("age.beforeBirth") : formatAge(ageDays);
}
