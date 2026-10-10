import { IonModal } from "@ionic/react";
import type { ImportBatch, ImportBatchError } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../i18n";
import { formatCount } from "../../lib/format";
import {
  cancelImport,
  importErrorKey,
  importsKey,
  isActiveBatch,
  useImportBatch,
} from "../../lib/googleImport";
import { photosRoot } from "../../lib/queries/photos";
import { Button, Message, Skeleton, SkeletonRegion } from "../ui";

/** Four result rows (imported, already here, skipped, failed) of a finished batch. */
export function ImportResults({ batch }: { batch: ImportBatch }) {
  const rows = [
    ["imported", batch.itemsImported, "google.result.imported"],
    ["duplicate", batch.itemsDuplicate, "google.result.duplicate"],
    ["skipped", batch.itemsSkipped, "google.result.skipped"],
    ["failed", batch.itemsFailed, "google.result.failed"],
  ] as const;
  return (
    <ul className="ll-list" data-testid="google-results">
      {rows.map(([key, n, label]) => (
        <li
          key={key}
          data-testid={`google-result-${key}`}
          className="flex min-h-12 items-center justify-between gap-3"
        >
          <span className={n === 0 ? "text-muted" : undefined}>{t(label)}</span>
          <span
            className={`tabular-nums ${key === "failed" && n > 0 ? "font-semibold text-danger-text" : n === 0 ? "text-muted" : "font-semibold"}`}
          >
            {formatCount(n)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BatchBody({
  batch,
  onClose,
  onAgain,
  contributor,
}: {
  batch: ImportBatch;
  onClose: () => void;
  onAgain: () => void;
  contributor: boolean;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await cancelImport(batch.id);
      qc.setQueryData(["imports", batch.id], b);
      void qc.invalidateQueries({ queryKey: importsKey(batch.babyId) });
    } catch (e) {
      setError(t(importErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const total = batch.itemsTotal;
  const done = batch.itemsImported + batch.itemsDuplicate + batch.itemsFailed + batch.itemsSkipped;
  const pct = total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (batch.status === "picking") {
    return (
      <>
        <h3 className="text-lg font-semibold" data-testid="google-sheet-state">
          {t("google.sheet.picking")}
        </h3>
        <p className="text-muted">{t("google.sheet.pickingBody")}</p>
        <div className="ll-progress" aria-hidden>
          <div style={{ width: "8%" }} />
        </div>
        {error ? <Message>{error}</Message> : null}
        <div className="flex flex-wrap items-center gap-3">
          {batch.isMine ? (
            <Button
              variant="secondary"
              data-testid="google-cancel"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {t("google.sheet.cancel")}
            </Button>
          ) : null}
          <Button variant="link" data-testid="google-hide" onClick={onClose}>
            {t("google.sheet.hide")}
          </Button>
        </div>
      </>
    );
  }

  if (batch.status === "queued" || batch.status === "running") {
    return (
      <>
        <h3 className="text-lg font-semibold" data-testid="google-sheet-state">
          {batch.status === "queued" ? t("google.sheet.queued") : t("google.sheet.running")}
        </h3>
        {total !== null ? (
          <p
            className="font-semibold tabular-nums"
            role="status"
            data-testid="google-progress-text"
          >
            {t("google.sheet.progress", { done: formatCount(done), total: formatCount(total) })}
          </p>
        ) : null}
        <div
          role="progressbar"
          aria-label={t("google.sheet.running")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="ll-progress"
        >
          <div style={{ width: `${total === null ? 8 : Math.max(pct, 4)}%` }} />
        </div>
        <p className="ll-hint">{t("google.sheet.keepOpen")}</p>
        {error ? <Message>{error}</Message> : null}
        <div className="flex flex-wrap items-center gap-3">
          {batch.isMine ? (
            <Button
              variant="secondary"
              data-testid="google-cancel"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {t("google.sheet.cancel")}
            </Button>
          ) : null}
          <Button variant="link" data-testid="google-hide" onClick={onClose}>
            {t("google.sheet.hide")}
          </Button>
        </div>
      </>
    );
  }

  if (batch.status === "done") {
    const none = batch.itemsImported === 0;
    return (
      <>
        <h3 className="text-lg font-semibold" data-testid="google-sheet-state">
          {none ? t("google.sheet.doneTitleEmpty") : t("google.sheet.doneTitle")}
        </h3>
        <ImportResults batch={batch} />
        {batch.itemsSkipped > 0 ? (
          <p className="ll-hint">{t("google.result.skippedHint")}</p>
        ) : null}
        {contributor && batch.itemsImported > 0 ? (
          <Message kind="info" data-testid="google-pending-note">
            {t("google.sheet.pendingNote")}
          </Message>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            data-testid="google-done"
            onClick={() => {
              onClose();
              if (!contributor && batch.itemsImported > 0) navigate("/timeline");
            }}
          >
            {!contributor && batch.itemsImported > 0
              ? t("google.sheet.viewTimeline")
              : t("google.sheet.done")}
          </Button>
          {!contributor && batch.itemsImported > 0 ? (
            <Button variant="link" data-testid="google-close" onClick={onClose}>
              {t("google.sheet.done")}
            </Button>
          ) : null}
        </div>
      </>
    );
  }

  if (batch.status === "expired") {
    return (
      <>
        <h3 className="text-lg font-semibold" data-testid="google-sheet-state">
          {t("google.sheet.expiredTitle")}
        </h3>
        <p className="text-muted">{t("google.sheet.expiredBody")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="google-again" onClick={onAgain}>
            {t("google.sheet.again")}
          </Button>
          <Button variant="link" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </>
    );
  }

  const failed = batch.status === "failed";
  const errKey = batch.error
    ? (`google.batchError.${batch.error satisfies ImportBatchError}` as const)
    : null;
  return (
    <>
      <h3 className="text-lg font-semibold" data-testid="google-sheet-state">
        {failed ? t("google.sheet.failedTitle") : t("google.sheet.cancelledTitle")}
      </h3>
      {failed && errKey ? <Message data-testid="google-batch-error">{t(errKey)}</Message> : null}
      {batch.itemsImported + batch.itemsDuplicate + batch.itemsSkipped + batch.itemsFailed > 0 ? (
        <ImportResults batch={batch} />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button data-testid="google-again" onClick={onAgain}>
          {t("google.sheet.again")}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t("google.sheet.done")}
        </Button>
      </div>
    </>
  );
}

/**
 * Progress and results of one Google Picker import. The picker page itself is opened by the caller
 * (system browser on native); this sheet only polls our API. `starting` covers the moment between
 * the tap and the batch id; `manualPickerUrl` is set only when the browser blocked the new tab.
 */
export function GoogleImportSheet({
  open,
  babyId,
  batchId,
  starting,
  startError,
  manualPickerUrl,
  contributor,
  onClose,
  onAgain,
}: {
  open: boolean;
  babyId: string;
  batchId: string | null;
  starting: boolean;
  startError: string | null;
  manualPickerUrl: string | null;
  contributor: boolean;
  onClose: () => void;
  onAgain: () => void;
}) {
  const qc = useQueryClient();
  const { data: batch, isError } = useImportBatch(open ? batchId : null);

  // A finished batch brings new photos and updates the recent-imports list, once.
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    if (!batch || isActiveBatch(batch)) return;
    const key = `${batch.id}:${batch.status}`;
    if (refreshed.current === key) return;
    refreshed.current = key;
    void qc.invalidateQueries({ queryKey: photosRoot(babyId) });
    void qc.invalidateQueries({ queryKey: ["babies", babyId, "milestones"] });
    void qc.invalidateQueries({ queryKey: importsKey(babyId) });
  }, [batch, babyId, qc]);

  return (
    <IonModal isOpen={open} onDidDismiss={onClose} className="ll-sheet">
      {open ? (
        <div
          data-testid="google-sheet"
          className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          <h2 className="text-xl font-semibold">{t("google.sheet.title")}</h2>
          {startError ? (
            <>
              <Message data-testid="google-start-error">{startError}</Message>
              <div className="flex gap-3">
                <Button variant="secondary" onClick={onClose}>
                  {t("google.sheet.done")}
                </Button>
              </div>
            </>
          ) : batch ? (
            <>
              {manualPickerUrl && batch.status === "picking" ? (
                <div className="flex flex-col gap-2">
                  <p className="text-muted">{t("google.sheet.openPickerHint")}</p>
                  <a
                    className="ll-btn ll-btn-primary"
                    href={manualPickerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="google-open-picker"
                  >
                    {t("google.sheet.openPicker")}
                  </a>
                </div>
              ) : null}
              <BatchBody
                batch={batch}
                onClose={onClose}
                onAgain={onAgain}
                contributor={contributor}
              />
            </>
          ) : isError ? (
            <>
              <Message>{t("google.err.generic")}</Message>
              <Button variant="secondary" onClick={onClose}>
                {t("google.sheet.done")}
              </Button>
            </>
          ) : (
            <SkeletonRegion
              label={starting ? t("google.sheet.starting") : t("common.loading")}
              className="flex flex-col gap-3"
            >
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-2 w-full" />
            </SkeletonRegion>
          )}
        </div>
      ) : null}
    </IonModal>
  );
}
