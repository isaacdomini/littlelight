import { t } from "../i18n";
import type { ItemErrorCode, UploadItem } from "../lib/upload/manager";
import { Button } from "./ui";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const ERR_KEYS = {
  unsupported: "upload.err.unsupported",
  too_large: "upload.err.too_large",
  unsupported_media_type: "upload.err.unsupported_media_type",
  file_too_large: "upload.err.file_too_large",
  decode_failed: "upload.err.decode_failed",
  free_tier_limit: "upload.err.free_tier_limit",
  rejected: "upload.err.rejected",
  expired: "upload.err.expired",
  storage_error: "upload.err.storage_error",
  upload_incomplete: "upload.err.upload_incomplete",
  network: "upload.err.network",
  unknown: "upload.err.unknown",
} as const satisfies Record<ItemErrorCode, `upload.err.${string}`>;

function stateLabel(item: UploadItem): string {
  if (item.state === "failed") return t(ERR_KEYS[item.error ?? "unknown"]);
  if (item.state === "uploading") {
    return t("upload.state.uploading", { pct: Math.round(item.progress * 100) });
  }
  return t(`upload.state.${item.state}`);
}

const CANCELABLE = new Set(["queued", "hashing", "registering", "uploading"]);

export function UploadRow({
  item,
  onRetry,
  onCancel,
}: {
  item: UploadItem;
  onRetry: (clientId: string) => void;
  onCancel: (clientId: string) => void;
}) {
  const busy = item.state === "uploading" || item.state === "completing";
  const failed = item.state === "failed";
  const done = item.state === "ingested" || item.state === "duplicate";
  return (
    <li
      data-testid={`upload-row-${item.clientId}`}
      data-state={item.state}
      data-filename={item.name}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
        <span className="shrink-0 text-sm text-muted">{formatBytes(item.size)}</span>
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
    </li>
  );
}
