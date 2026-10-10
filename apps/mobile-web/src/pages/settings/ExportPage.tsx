import type { DataExport, ExportStatus } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { useFreshSignIn } from "../../auth/FreshSignInGate";
import { SubPage } from "../../components/Page";
import { Button, Card, CheckField, EmptyState, ListSkeleton, Message } from "../../components/ui";
import { type MessageKey, t } from "../../i18n";
import { en } from "../../i18n/en";
import { ApiError, errorMessage, isApiError } from "../../lib/api";
import {
  deleteExport,
  exportsKey,
  isActiveExport,
  mintExportUrl,
  requestExport,
  useExports,
} from "../../lib/queries";
import { isNative } from "../../platform/platform";

const CHIP_TONE: Record<ExportStatus, string> = {
  queued: "bg-fill text-muted",
  running: "bg-fill text-muted",
  ready: "bg-fill text-success-text",
  failed: "bg-fill text-danger-text",
  expired: "bg-fill text-muted",
};

/** A friendly line for each export error code; unknown codes fall back to the server message. */
function exportErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const key = `export.err.${e.code}` as MessageKey;
    if (key in en) return t(key);
    if (e.code === "network") return e.message;
    return t("export.err.generic");
  }
  return errorMessage(e);
}
function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function ExportRow({
  item,
  busy,
  onDownload,
  onDelete,
}: {
  item: DataExport;
  busy: boolean;
  onDownload: (e: DataExport) => void;
  onDelete: (e: DataExport) => void;
}) {
  const active = isActiveExport(item);
  const total = item.photoCount;
  const pct = total ? Math.min(100, Math.round((item.photosDone / total) * 100)) : 0;
  const who = item.isMine ? t("export.you") : item.requestedByName?.trim() || t("export.someone");
  return (
    <li
      className="flex flex-col gap-3"
      data-testid={`export-${item.status}`}
      data-export-id={item.id}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={`inline-flex min-h-8 items-center rounded-full px-3 text-sm font-semibold ${CHIP_TONE[item.status]}`}
          data-testid="export-status"
        >
          {t(`export.status.${item.status}`)}
        </span>
        <span className="text-sm text-muted">{dateText(item.createdAt)}</span>
      </div>
      <p className="text-sm text-muted">
        {t("export.requestedBy", { name: who })}
        {" · "}
        {item.includeLocation ? t("export.withLocation") : t("export.withoutLocation")}
      </p>

      {active ? (
        <div className="flex flex-col gap-2" data-testid="export-progress">
          <p className="text-sm">
            {item.status === "queued" ? t("export.queuedBody") : t("export.runningBody")}
            {item.status === "running" && total
              ? ` · ${t("export.progress", { done: item.photosDone, total })}`
              : ""}
          </p>
          <div
            role="progressbar"
            aria-label={t("export.runningBody")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={item.status === "running" ? pct : undefined}
            className="h-2 overflow-hidden rounded-full bg-fill"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
              style={{ width: `${item.status === "running" ? Math.max(pct, 4) : 4}%` }}
            />
          </div>
        </div>
      ) : null}

      {item.status === "ready" ? (
        <p className="text-sm">
          {item.bytes != null ? `${formatSize(item.bytes)} · ` : ""}
          {t("export.expires", { date: dateText(item.expiresAt) })}
        </p>
      ) : null}
      {item.status === "expired" ? (
        <p className="text-sm text-muted">
          {t("export.expiredOn", { date: dateText(item.expiresAt) })}
        </p>
      ) : null}
      {item.status === "failed" ? (
        <p className="text-sm" data-testid="export-failed">
          {t(`export.failed.${item.error ?? "internal"}`)}
        </p>
      ) : null}
      {item.status === "ready" && !item.isMine ? (
        <p className="text-sm text-muted">{t("export.onlyRequester")}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {item.canDownload ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="export-download"
            disabled={busy}
            onClick={() => onDownload(item)}
          >
            {t("export.download")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="danger"
          data-testid="export-delete"
          disabled={busy}
          onClick={() => onDelete(item)}
        >
          {t("export.delete")}
        </Button>
      </div>
    </li>
  );
}

/** Settings -> Export your data (admins only; docs/plans/review-fixes.md R.11, D1-D6). */
export function ExportPage() {
  const qc = useQueryClient();
  const { baby } = useCurrentBaby();
  const withFresh = useFreshSignIn();
  const babyId = baby?.id;
  const isAdmin = baby?.role === "admin";
  const list = useExports(isAdmin ? babyId : undefined);
  const [includeLocation, setIncludeLocation] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!baby || !isAdmin) {
    return (
      <SubPage title={t("export.title")} backHref="/settings">
        <Message>{t("export.err.forbidden")}</Message>
      </SubPage>
    );
  }

  const refresh = () => qc.invalidateQueries({ queryKey: exportsKey(baby.id) });
  const items = list.data?.exports ?? [];
  const hasActive = items.some(isActiveExport);

  async function run(fn: () => Promise<void>, after?: () => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(exportErrorText(e));
      if (isApiError(e, "export_in_progress") || isApiError(e, "export_expired")) void refresh();
    } finally {
      setBusy(false);
    }
  }

  const request = () =>
    run(
      async () => {
        await withFresh(() => requestExport(baby.id, { includeLocation }));
        await refresh();
      },
      () => setNotice(t("export.requested")),
    );

  const download = (item: DataExport) =>
    run(async () => {
      // The signed URL lives only in this closure: used at once, never stored or logged.
      const { url } = await withFresh(() => mintExportUrl(baby.id, item.id));
      const name = `littlelight-export-${item.createdAt.slice(0, 10)}.zip`;
      if (isNative()) {
        // A ZIP of originals can be many GB: stream it with the native downloader, then hand
        // the file to the share sheet (Save to Files / AirDrop). The in-WebView blob path would
        // exhaust memory.
        const { downloadLargeAndShare } = await import("../../platform/native/share");
        if (!(await downloadLargeAndShare(url, name))) throw new Error("download");
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });

  const remove = (item: DataExport) => {
    if (!window.confirm(t("export.deleteConfirm"))) return;
    void run(async () => {
      await deleteExport(baby.id, item.id);
      await refresh();
    });
  };

  return (
    <SubPage title={t("export.title")} backHref="/settings">
      <div className="flex flex-col gap-4" data-testid="export-page">
        <p className="text-muted">{t("export.intro")}</p>
        <Card className="flex flex-col gap-3">
          <div>
            <CheckField
              label={t("export.location")}
              checked={includeLocation}
              onChange={(e) => setIncludeLocation(e.target.checked)}
              data-testid="export-location"
              aria-describedby="export-location-hint"
            />
            <p id="export-location-hint" className="pl-9 text-sm text-muted">
              {t("export.locationHint")}
            </p>
          </div>
          <Button
            data-testid="export-request"
            disabled={busy || hasActive}
            onClick={() => void request()}
          >
            {busy ? t("export.requesting") : t("export.request")}
          </Button>
        </Card>

        {error ? <Message data-testid="export-error">{error}</Message> : null}
        {notice ? (
          <Message kind="info" data-testid="export-notice">
            {notice}
          </Message>
        ) : null}
        {list.isError ? <Message>{exportErrorText(list.error)}</Message> : null}

        <section aria-labelledby="export-history-h" className="flex flex-col gap-3">
          <h2 id="export-history-h" className="text-xl font-semibold">
            {t("export.history")}
          </h2>
          {list.isPending && !list.isError ? <ListSkeleton rows={2} /> : null}
          {list.data && items.length === 0 ? (
            <EmptyState data-testid="export-empty">{t("export.empty")}</EmptyState>
          ) : null}
          {items.length > 0 ? (
            <ul className="ll-list" data-testid="export-list">
              {items.map((item) => (
                <ExportRow
                  key={item.id}
                  item={item}
                  busy={busy}
                  onDownload={(e) => void download(e)}
                  onDelete={remove}
                />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </SubPage>
  );
}
