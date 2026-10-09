import { t } from "../../i18n";

/** "5 hours", "3 days", "12 minutes" until `iso` (never negative). */
export function timeUntil(iso: string, now = Date.now()): string {
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const min = Math.round(ms / 60_000);
  if (min < 60) return t("share.time.minutes", { n: Math.max(1, min) });
  const h = Math.round(min / 60);
  if (h < 48) return t("share.time.hours", { n: h });
  return t("share.time.days", { n: Math.round(h / 24) });
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "2 hours ago" style label. */
export function timeAgo(iso: string, now = Date.now()): string {
  const sec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86_400), "day");
}

/** Copy text; falls back to a hidden textarea where the Clipboard API is missing (WebViews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
