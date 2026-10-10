import { IonAlert, IonIcon } from "@ionic/react";
import { FREE_TIER_PHOTO_LIMIT, type ImportSource } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { albumsOutline } from "ionicons/icons";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t } from "../../i18n";
import { formatCount } from "../../lib/format";
import { importSourcesKey, useThisDeviceImportSource } from "../../lib/queries/imports";
import { photoSync, type SyncStatus, useSyncStatus } from "../../platform/native/photoSync";
import { timeAgo } from "../share/format";
import { Button, Card, CheckField, Message, Skeleton, SkeletonRegion } from "../ui";
import { SetupSyncSheet } from "./SetupSyncSheet";

/** One line that says what sync is doing (or why it is not). */
export function syncStatusLine(
  status: SyncStatus,
  source: ImportSource | null | undefined,
): string {
  const err = status.lastError ?? source?.lastError ?? null;
  if (err && err !== "signed_out") {
    return err === "free_tier_limit"
      ? t("sync.error.free_tier_limit", { n: formatCount(FREE_TIER_PHOTO_LIMIT) })
      : t(`sync.error.${err}`);
  }
  switch (status.phase) {
    case "syncing":
      return status.progress && status.progress.total > 0
        ? t("sync.status.progress", {
            done: formatCount(status.progress.done),
            total: formatCount(status.progress.total),
          })
        : t("sync.status.syncing");
    case "waiting_wifi":
      return t("sync.status.wifi");
    case "low_power":
      return t("sync.status.lowPower");
    case "paused":
      return t("sync.status.paused");
    default:
      if (source?.lastSyncAt) {
        return t("sync.status.upToDateCount", { n: formatCount(source.importedCount) });
      }
      return status.lastRunAt ? t("sync.status.upToDate") : t("sync.status.ready");
  }
}

function isErrorLine(status: SyncStatus, source: ImportSource | null | undefined): boolean {
  const err = status.lastError ?? source?.lastError ?? null;
  return err !== null && err !== "signed_out";
}

/**
 * Album sync card (iPhone, admins). `compact` (Upload screen): status and "Sync now", with a link
 * to the full controls; the full card (Settings -> Photo import) adds pause, Wi-Fi only,
 * change album and stop. Lazy-loaded: the web bundle never contains it.
 */
export function SyncCard({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { baby, babies } = useCurrentBaby();
  const status = useSyncStatus();
  const [setup, setSetup] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const cfg = status.config;
  const { data: source } = useThisDeviceImportSource(cfg?.babyId, status.loaded && cfg !== null);

  // Refresh the server counters when a run ends.
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && status.phase !== "syncing" && cfg) {
      void qc.invalidateQueries({ queryKey: importSourcesKey(cfg.babyId) });
    }
    wasSyncing.current = status.phase === "syncing";
  }, [status.phase, cfg, qc]);

  if (!status.loaded) {
    return (
      <Card data-testid="sync-card-loading">
        <SkeletonRegion label={t("common.loading")} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </SkeletonRegion>
      </Card>
    );
  }

  if (!cfg) {
    return (
      <>
        <Card data-testid="sync-card" className="flex flex-col items-start gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-text"
            >
              <IonIcon icon={albumsOutline} className="h-5 w-5" />
            </span>
            <h2 className="text-lg font-semibold">{t("sync.card.title")}</h2>
          </div>
          {status.notice === "removed" ? (
            <Message kind="info" data-testid="sync-removed">
              {t("sync.notice.removed")}
            </Message>
          ) : null}
          <p className="text-muted" data-testid="sync-empty">
            {t("sync.empty")}
          </p>
          <Button variant="secondary" data-testid="sync-setup-open" onClick={() => setSetup(true)}>
            {t("sync.setup")}
          </Button>
        </Card>
        <SetupSyncSheet open={setup} onClose={() => setSetup(false)} />
      </>
    );
  }

  const syncing = status.phase === "syncing";
  const line = syncStatusLine(status, source);
  const needsSettings = (status.lastError ?? source?.lastError) === "permission_denied";
  const syncedBaby = babies.find((b) => b.id === cfg.babyId) ?? baby;
  const progressPct =
    status.progress && status.progress.total > 0
      ? Math.round((status.progress.done / status.progress.total) * 100)
      : 0;

  return (
    <>
      <Card data-testid="sync-card" className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-text"
          >
            <IonIcon icon={albumsOutline} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{t("sync.card.title")}</h2>
            <p className="truncate text-muted" data-testid="sync-album">
              {t("sync.card.album", { title: cfg.albumTitle })}
              {syncedBaby && babies.length > 1
                ? ` · ${t("sync.card.baby", { name: syncedBaby.nickname ?? syncedBaby.name })}`
                : ""}
            </p>
          </div>
        </div>

        <p
          role="status"
          data-testid="sync-status"
          className={
            isErrorLine(status, source) ? "font-semibold text-danger-text" : "font-semibold"
          }
        >
          {line}
        </p>
        {syncing ? (
          <div
            role="progressbar"
            aria-label={t("sync.card.title")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            className="ll-progress"
          >
            <div style={{ width: `${progressPct}%` }} />
          </div>
        ) : null}
        {needsSettings ? <p className="ll-hint">{t("sync.permissionHelp")}</p> : null}
        {!compact && source?.lastSyncAt ? (
          <p className="ll-caption" data-testid="sync-last">
            {t("sync.status.lastSync", { when: timeAgo(source.lastSyncAt) })}
            {" · "}
            {t("sync.status.counts", {
              imported: formatCount(source.importedCount),
              duplicate: formatCount(source.duplicateCount),
              failed: formatCount(source.failedCount),
              skipped: formatCount(source.skippedCount),
            })}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={compact ? "secondary" : "primary"}
            data-testid="sync-now"
            disabled={syncing}
            onClick={() => void photoSync.runSync("manual")}
          >
            {t("sync.syncNow")}
          </Button>
          {compact ? (
            <Button
              variant="link"
              data-testid="sync-manage"
              onClick={() => navigate("/settings/import")}
            >
              {t("sync.more")}
            </Button>
          ) : null}
        </div>

        {compact ? null : (
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <CheckField
              data-testid="sync-wifi-toggle"
              label={t("sync.wifiOnly")}
              checked={cfg.wifiOnly}
              onChange={(e) => void photoSync.setWifiOnly(e.target.checked)}
            />
            <p className="ll-hint">{t("sync.wifiOnlyHint")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                data-testid="sync-pause"
                onClick={() => void photoSync.setPaused(!cfg.paused)}
              >
                {cfg.paused ? t("sync.resume") : t("sync.pause")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="sync-change"
                onClick={() => setSetup(true)}
              >
                {t("sync.changeAlbum")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="sync-stop"
                onClick={() => setConfirmStop(true)}
              >
                {t("sync.stop")}
              </Button>
            </div>
          </div>
        )}
      </Card>
      <SetupSyncSheet open={setup} onClose={() => setSetup(false)} />
      <IonAlert
        isOpen={confirmStop}
        header={t("sync.stopConfirm.title")}
        message={t("sync.stopConfirm.body")}
        onWillDismiss={() => setConfirmStop(false)}
        buttons={[
          { text: t("common.cancel"), role: "cancel" },
          {
            text: t("sync.stopConfirm.action"),
            role: "destructive",
            handler: () => void photoSync.disable(),
          },
        ]}
      />
    </>
  );
}
