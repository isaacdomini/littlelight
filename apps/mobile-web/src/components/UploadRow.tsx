import { IonIcon } from "@ionic/react";
import { formatDuration, VIDEO_LARGE_FILE_BYTES } from "@tinyglow/shared";
import { videocamOutline } from "ionicons/icons";
import { t } from "../i18n";
import type { ItemErrorCode, UploadItem } from "../lib/upload/manager";
import { isNative } from "../platform/platform";
import { Button } from "./ui";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const ERR_KEYS = {
  unsupported: "upload.err.unsupported",
  too_large: "upload.err.too_large",
  unsupported_media_type: "upload.err.unsupported_media_type",
  file_too_large: "upload.err.file_too_large",
  decode_failed: "upload.err.decode_failed",
  free_tier_limit: "upload.err.free_tier_limit",
  pending_limit: "upload.err.pending_limit",
  rejected: "upload.err.rejected",
  expired: "upload.err.expired",
  storage_error: "upload.err.storage_error",
  upload_incomplete: "upload.err.upload_incomplete",
  video_too_long: "upload.err.video.too_long.plus",
  transcode_failed: "upload.err.transcode_failed",
  no_space: "upload.err.no_space",
  bad_range: "upload.err.bad_range",
  network: "upload.err.network",
  unknown: "upload.err.unknown",
} as const satisfies Record<ItemErrorCode, `upload.err.${string}`>;

/**
 * Video refusals read per plan (docs/plans/step-12.md 2.11); the native apps never mention
 * Plus. An unknown plan gets the Plus (absolute) wording, which names no price or upgrade.
 */
function videoError(item: UploadItem): string | null {
  const free = item.plan === "free";
  const native = isNative();
  switch (item.error) {
    case "too_large":
    case "file_too_large":
      if (!free) return t("upload.err.video.file_too_large.plus");
      return t(
        native
          ? "upload.err.video.file_too_large.free.native"
          : "upload.err.video.file_too_large.free",
        { size: formatBytes(item.size) },
      );
    case "video_too_long":
      if (!free) return t("upload.err.video.too_long.plus");
      return t(native ? "upload.err.video.too_long.free.native" : "upload.err.video.too_long.free");
    case "free_tier_limit":
      return t(
        native ? "upload.err.video.free_tier_limit.native" : "upload.err.video.free_tier_limit",
      );
    case "decode_failed":
      return t("upload.err.video.decode_failed");
    default:
      return null;
  }
}

function stateLabel(item: UploadItem): string {
  if (item.state === "failed") {
    if (item.kind === "video") {
      const v = videoError(item);
      if (v) return v;
    }
    // No purchase prompts in the app: the native wording drops "Upgrade to Plus".
    if (item.error === "free_tier_limit" && isNative())
      return t("upload.err.free_tier_limit.native");
    if (item.error === "pending_limit" && item.errorDetail) return item.errorDetail;
    return t(ERR_KEYS[item.error ?? "unknown"]);
  }
  if (item.state === "uploading") {
    return t("upload.state.uploading", { pct: Math.round(item.progress * 100) });
  }
  return t(`upload.state.${item.state}`);
}

const CANCELABLE = new Set(["queued", "hashing", "registering", "uploading"]);
/** The cellular switch only matters before the bytes start moving. */
const BEFORE_TRANSFER = new Set(["queued", "hashing", "registering"]);

export function UploadRow({
  item,
  onRetry,
  onCancel,
  onWifiOnly,
}: {
  item: UploadItem;
  onRetry: (clientId: string) => void;
  onCancel: (clientId: string) => void;
  /** Native, large videos: the per-item "Use cellular" switch (Q6). */
  onWifiOnly?: (clientId: string, wifiOnly: boolean) => void;
}) {
  const busy = item.state === "uploading" || item.state === "completing";
  const failed = item.state === "failed";
  const done = item.state === "ingested" || item.state === "duplicate";
  const video = item.kind === "video";
  const kindText =
    video && item.durationMs !== undefined
      ? t("upload.kind.videoDuration", { duration: formatDuration(item.durationMs) })
      : video
        ? t("upload.kind.video")
        : null;
  const cellularSwitch =
    video &&
    isNative() &&
    onWifiOnly &&
    item.size > VIDEO_LARGE_FILE_BYTES &&
    BEFORE_TRANSFER.has(item.state);
  return (
    <li
      data-testid={`upload-row-${item.clientId}`}
      data-state={item.state}
      data-filename={item.name}
      data-kind={item.kind}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        {video ? (
          <IonIcon
            icon={videocamOutline}
            aria-hidden
            className="h-5 w-5 shrink-0 text-muted"
            data-testid={`upload-video-icon-${item.clientId}`}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
        <span className="shrink-0 text-sm text-muted">
          {kindText ? (
            <>
              <span data-testid={`upload-kind-${item.clientId}`}>{kindText}</span>
              {" · "}
            </>
          ) : null}
          {formatBytes(item.size)}
        </span>
      </div>
      {busy ? (
        <div
          role="progressbar"
          aria-label={item.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.progress * 100)}
          className="ll-progress"
        >
          <div style={{ width: `${Math.round(item.progress * 100)}%` }} />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 text-sm ${failed ? "font-semibold text-danger-text" : done ? "text-success-text" : "text-muted"}`}
          role={failed ? "alert" : undefined}
        >
          {stateLabel(item)}
        </span>
        {failed && item.retryable ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid={`upload-retry-${item.clientId}`}
            aria-label={t("upload.retryFile", { name: item.name })}
            onClick={() => onRetry(item.clientId)}
          >
            {t("upload.retry")}
          </Button>
        ) : null}
        {CANCELABLE.has(item.state) ? (
          <Button
            variant="link"
            size="sm"
            data-testid={`upload-cancel-${item.clientId}`}
            aria-label={t("upload.cancelFile", { name: item.name })}
            onClick={() => onCancel(item.clientId)}
          >
            {t("upload.cancel")}
          </Button>
        ) : null}
      </div>
      {cellularSwitch ? (
        <label
          className="flex min-h-11 items-center justify-between gap-3 text-sm"
          data-testid={`upload-cellular-${item.clientId}`}
        >
          <span className="text-muted">
            {t("upload.wifiOnly")} {t("upload.useCellular")}
          </span>
          <input
            type="checkbox"
            checked={!item.wifiOnly}
            onChange={(e) => onWifiOnly(item.clientId, !e.target.checked)}
          />
        </label>
      ) : null}
    </li>
  );
}
