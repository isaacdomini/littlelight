import type { PhotoSummary } from "@littlelight/shared";
import { t } from "../i18n";
import { ageText } from "./age";

export interface AltTextBaby {
  name: string;
  nickname?: string | null;
}

export type AltTextPhoto = Pick<PhotoSummary, "caption" | "ageDays" | "takenAt">;

/** "Jun 14, 2026" in `timeZone` (default: the browser's). */
export function formatPhotoDate(takenAt: string | null, timeZone?: string): string | null {
  if (!takenAt) return null;
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(d);
  }
}

/**
 * Alt text: the caption (AI caption or the parent's override) when present, otherwise
 * "{baby} at {age}, {date}" plus ", {milestone}". Plain text only; never includes notes.
 */
export function photoAltText(
  photo: AltTextPhoto,
  baby: AltTextBaby | null | undefined,
  milestoneName?: string | null,
  timeZone?: string,
): string {
  const caption = photo.caption?.trim();
  if (caption) return caption;
  const name = baby ? baby.nickname?.trim() || baby.name : t("app.name");
  const date = formatPhotoDate(photo.takenAt, timeZone);
  const hasAge = photo.ageDays !== null;
  const age = hasAge ? ageText(photo.ageDays) : "";
  let alt: string;
  if (hasAge && date) alt = t("photo.altFallback", { baby: name, age, date });
  else if (hasAge) alt = t("photo.altFallbackNoDate", { baby: name, age });
  else if (date) alt = t("photo.altFallbackNoAge", { baby: name, date });
  else alt = t("photo.altUndated", { baby: name });
  return milestoneName ? t("photo.altMilestone", { alt, milestone: milestoneName }) : alt;
}
