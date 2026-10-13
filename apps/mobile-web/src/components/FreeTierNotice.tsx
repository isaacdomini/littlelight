import type { BabySummary } from "@tinyglow/shared";
import { t, tn } from "../i18n";
import { formatCount } from "../lib/format";
import { useFreeTier } from "../lib/queries/freeTier";
import { isNative } from "../platform/platform";

/** Show the "almost full" warning from this many photos (90% of the 1,000 pool). */
export const FREE_TIER_NEAR_FULL = 900;

/**
 * Family usage: "Your family's free photos: 940 of 1,000 (across 2 albums)" (parents) or "This family's free photos: 940 of 1,000" (guests), a near-full warning and the
 * over-cap line (docs/plans/step-11.md 2.9). Renders nothing for Plus or trashed albums.
 * The app (native) never prompts to buy Plus: it says the albums are full and stops there; so
 * does the web copy for contributors, who cannot upgrade an album anyway.
 */
export function FreeTierNotice({ baby }: { baby: Pick<BabySummary, "id" | "plan" | "role"> }) {
  const { data } = useFreeTier(baby.id, baby.plan === "free");
  if (!data) return null;
  const { used, limit, familyAlbums } = data;
  const nums = { used: formatCount(used), limit: formatCount(limit) };
  const canUpsell = !isNative() && baby.role === "admin";
  // Step 12 (Q3): the usage line carries the family's video count when the API sends it.
  const videos = typeof data.videos === "number" ? data.videos : undefined;
  const videoLimit = typeof data.videoLimit === "number" ? data.videoLimit : undefined;
  const videoNums =
    videos !== undefined && videoLimit !== undefined
      ? { ...nums, videos: formatCount(videos), videoLimit: formatCount(videoLimit) }
      : null;
  const videosFull = videoNums !== null && (videos as number) >= (videoLimit as number);

  let tone: "ok" | "near" | "over" = "ok";
  if (used >= limit) tone = "over";
  else if (used >= FREE_TIER_NEAR_FULL) tone = "near";

  let body: string;
  if (tone === "over") {
    body = isNative()
      ? t(baby.role === "admin" ? "freeTier.overParent.native" : "freeTier.overMember", nums)
      : canUpsell
        ? t("freeTier.over", nums)
        : t("freeTier.overMember", nums);
  } else if (videoNums) {
    body =
      baby.role === "admin"
        ? tn("freeTier.usageVideos", familyAlbums, videoNums)
        : t("freeTier.usageGuestVideos", videoNums);
  } else {
    body =
      baby.role === "admin"
        ? tn("freeTier.usage", familyAlbums, nums)
        : t("freeTier.usageGuest", nums);
  }

  return (
    <div
      data-testid="free-tier-notice"
      data-tone={tone}
      data-videos={videos}
      className={`ll-callout flex flex-col gap-1 ${tone === "ok" && !videosFull ? "" : "!border-[var(--warning)]"}`}
    >
      <p
        role={tone === "ok" ? undefined : "status"}
        className={tone === "over" ? "font-semibold" : tone === "ok" ? "text-muted" : undefined}
      >
        {body}
      </p>
      {videosFull && tone !== "over" && videoNums ? (
        <p role="status" className="font-semibold" data-testid="free-tier-videos-full">
          {t(
            isNative()
              ? "freeTier.videosFull.native"
              : canUpsell
                ? "freeTier.videosFull"
                : "freeTier.videosFullMember",
            videoNums,
          )}
        </p>
      ) : null}
      {tone === "near" ? (
        <p className="text-muted" data-testid="free-tier-near">
          {t("freeTier.near", { left: formatCount(limit - used) })} {t("freeTier.nearHint")}
          {canUpsell ? t("freeTier.nearUpgrade") : ""}
        </p>
      ) : null}
    </div>
  );
}
