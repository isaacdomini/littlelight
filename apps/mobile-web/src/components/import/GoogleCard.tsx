import { IonAlert, IonIcon } from "@ionic/react";
import type { GoogleConnectReturnPath, ImportBatch } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { logoGoogle } from "ionicons/icons";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t } from "../../i18n";
import { isApiError } from "../../lib/api";
import { formatCount } from "../../lib/format";
import {
  createImport,
  discardWindow,
  disconnectGoogle,
  googleConnectionKey,
  importErrorKey,
  importsKey,
  isActiveBatch,
  openExternal,
  preopenWindow,
  requestConnectUrl,
  useGoogleConnection,
  useRecentImports,
  useRefreshOnReturn,
} from "../../lib/googleImport";
import { isNative } from "../../platform/platform";
import { timeAgo } from "../share/format";
import { Button, Card, Message, Skeleton, SkeletonRegion } from "../ui";
import { GoogleImportSheet } from "./GoogleImportSheet";

const CHIP_TONE: Record<ImportBatch["status"], string> = {
  picking: "bg-fill text-muted",
  queued: "bg-fill text-muted",
  running: "bg-fill text-accent-text",
  done: "bg-fill text-success-text",
  failed: "bg-fill text-danger-text",
  cancelled: "bg-fill text-muted",
  expired: "bg-fill text-muted",
};

/** "1,180 imported · 41 already here", only the non-zero parts. */
function summaryLine(b: ImportBatch): string {
  const parts = [
    b.itemsImported > 0 && t("google.recent.imported", { n: formatCount(b.itemsImported) }),
    b.itemsDuplicate > 0 && t("google.recent.duplicate", { n: formatCount(b.itemsDuplicate) }),
    b.itemsSkipped > 0 && t("google.recent.skipped", { n: formatCount(b.itemsSkipped) }),
    b.itemsFailed > 0 && t("google.recent.failed", { n: formatCount(b.itemsFailed) }),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("google.recent.none");
}

function RecentImports({ batches }: { batches: ImportBatch[] }) {
  return (
    <section className="flex flex-col gap-2" data-testid="google-recent">
      <h3 className="ll-label">{t("google.recent")}</h3>
      {batches.length === 0 ? (
        <p className="text-muted" data-testid="google-recent-empty">
          {t("google.recent.empty")}
        </p>
      ) : (
        <ul className="ll-list">
          {batches.map((b) => {
            const doneN = b.itemsImported + b.itemsDuplicate + b.itemsFailed + b.itemsSkipped;
            return (
              <li key={b.id} data-testid="google-recent-row" className="flex flex-col gap-1 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 font-semibold">
                    {timeAgo(b.startedAt ?? b.createdAt)}
                    {!b.isMine && b.requestedByName ? (
                      <span className="font-normal text-muted">
                        {" · "}
                        {t("google.recent.by", { name: b.requestedByName })}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${CHIP_TONE[b.status]}`}
                  >
                    {t(`google.status.${b.status}`)}
                  </span>
                </div>
                <p className="ll-caption tabular-nums">
                  {isActiveBatch(b) && b.itemsTotal !== null
                    ? t("google.recent.progress", {
                        done: formatCount(doneN),
                        total: formatCount(b.itemsTotal),
                      })
                    : summaryLine(b)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Google Photos import card. `compact` (Upload screen): the import button plus status and a link to
 * the full controls; the full card (Settings -> Photo import) adds recent imports and disconnect.
 * Renders nothing when the server has Google import switched off.
 */
export function GoogleCard({
  compact = false,
  returnTo,
}: {
  compact?: boolean;
  returnTo: GoogleConnectReturnPath;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const babyId = baby?.id;
  const canImport = baby?.role === "admin" || baby?.role === "contributor";
  const contributor = baby?.role === "contributor";
  const conn = useGoogleConnection();
  const connected = conn.data?.connected === true && !conn.data.needsReconnect;
  const recent = useRecentImports(babyId, connected, compact ? 3 : 5);
  const active = recent.data?.find(isActiveBatch) ?? null;

  const [sheetOpen, setSheetOpen] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectNote, setConnectNote] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [manualConnectUrl, setManualConnectUrl] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  useRefreshOnReturn(babyId);

  // Back from consent: the connection flips to connected, the "waiting" note goes away.
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) {
      setConnectNote(false);
      setManualConnectUrl(null);
    }
    wasConnected.current = connected;
  }, [connected]);

  if (conn.isPending) {
    return (
      <Card data-testid="google-card-loading">
        <SkeletonRegion label={t("common.loading")} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </SkeletonRegion>
      </Card>
    );
  }
  if (conn.isError) {
    return (
      <Card data-testid="google-card">
        <Message data-testid="google-check-error">{t("google.checkError")}</Message>
      </Card>
    );
  }
  if (!conn.data.available) return null;

  const connect = async () => {
    const pre = preopenWindow();
    setConnectBusy(true);
    setConnectError(null);
    setManualConnectUrl(null);
    try {
      const url = await requestConnectUrl(returnTo);
      const ok = await openExternal(url, pre);
      if (!ok) setManualConnectUrl(url);
      setConnectNote(true);
    } catch (e) {
      discardWindow(pre);
      setConnectError(t(importErrorKey(e)));
    } finally {
      setConnectBusy(false);
    }
  };

  const start = async () => {
    if (!babyId) return;
    if (active) {
      setBatchId(active.id);
      setStartError(null);
      setSheetOpen(true);
      return;
    }
    const pre = preopenWindow();
    setBatchId(null);
    setStartError(null);
    setManualUrl(null);
    setStarting(true);
    setSheetOpen(true);
    try {
      const res = await createImport(babyId);
      qc.setQueryData(["imports", res.batch.id], res.batch);
      setBatchId(res.batch.id);
      void qc.invalidateQueries({ queryKey: importsKey(babyId) });
      // pickerUri is used at once and dropped; kept in state only when the tab was blocked.
      const ok = await openExternal(res.pickerUri, pre);
      if (!ok) setManualUrl(res.pickerUri);
    } catch (e) {
      discardWindow(pre);
      if (isApiError(e, "import_in_progress")) {
        const running = (await recent.refetch()).data?.find(isActiveBatch);
        if (running) {
          setBatchId(running.id);
          return;
        }
      }
      if (isApiError(e, "google_reconnect") || isApiError(e, "google_not_connected")) {
        void qc.invalidateQueries({ queryKey: googleConnectionKey });
      }
      setStartError(t(importErrorKey(e)));
    } finally {
      setStarting(false);
    }
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setManualUrl(null);
    if (babyId) void qc.invalidateQueries({ queryKey: importsKey(babyId) });
  };

  const disconnect = async () => {
    setDisconnectError(null);
    try {
      await disconnectGoogle();
      qc.setQueryData(googleConnectionKey, {
        available: true,
        connected: false,
        connectedAt: null,
        needsReconnect: false,
      });
      void qc.invalidateQueries({ queryKey: googleConnectionKey });
    } catch (e) {
      setDisconnectError(t(importErrorKey(e)));
    }
  };

  const needsReconnect = conn.data.connected && conn.data.needsReconnect;
  const hint = isNative() ? t("google.connectHintNative") : t("google.connectHint");

  const icon = (
    <span
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-text"
    >
      <IonIcon icon={logoGoogle} className="h-5 w-5" />
    </span>
  );

  return (
    <>
      <Card data-testid="google-card" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{t("google.heading")}</h2>
            {connected ? (
              <p className="text-sm text-success-text" data-testid="google-connected">
                {conn.data.connectedAt
                  ? t("google.connectedSince", { when: timeAgo(conn.data.connectedAt) })
                  : t("google.connected")}
              </p>
            ) : null}
          </div>
        </div>

        {!connected && !needsReconnect ? (
          <p className="text-muted" data-testid="google-intro">
            {t("google.intro")}
          </p>
        ) : null}
        {needsReconnect ? (
          <Message data-testid="google-reconnect-note">
            {`${t("google.reconnectTitle")}. ${t("google.reconnectBody")}`}
          </Message>
        ) : null}
        <p className="ll-hint" data-testid="google-location-note">
          {t("google.locationNote")}
        </p>
        {contributor ? (
          <p className="ll-hint" data-testid="google-contributor-note">
            {t("google.contributorNote")}
          </p>
        ) : null}

        {connectError ? <Message data-testid="google-connect-error">{connectError}</Message> : null}

        {!canImport ? (
          <p className="text-muted">{t("google.noBaby")}</p>
        ) : connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={compact ? "secondary" : "primary"}
              data-testid="google-import"
              onClick={() => void start()}
            >
              {active ? t("google.importShow") : t("google.import")}
            </Button>
            {active ? (
              <span className="text-sm text-muted" data-testid="google-active">
                {t("google.inProgress")}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <Button
              data-testid="google-connect"
              disabled={connectBusy}
              onClick={() => void connect()}
            >
              {needsReconnect ? t("google.reconnect") : t("google.connect")}
            </Button>
            {connectNote ? (
              <p className="ll-hint" role="status" data-testid="google-connect-wait">
                {t("google.connecting")} {hint}
              </p>
            ) : null}
            {manualConnectUrl ? (
              <a
                className="ll-link"
                href={manualConnectUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="google-connect-link"
              >
                {t("google.connect")}
              </a>
            ) : null}
          </div>
        )}

        {connected && compact ? (
          <Button
            variant="link"
            className="self-start !px-0"
            data-testid="google-manage"
            onClick={() => navigate("/settings/import")}
          >
            {t("sync.more")}
          </Button>
        ) : null}

        {!compact && connected && babyId ? (
          <>
            <div className="border-t border-line pt-3">
              {recent.isPending ? (
                <SkeletonRegion label={t("common.loading")} className="flex flex-col gap-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </SkeletonRegion>
              ) : (
                <RecentImports batches={recent.data ?? []} />
              )}
            </div>
            {disconnectError ? <Message>{disconnectError}</Message> : null}
            <div className="border-t border-line pt-3">
              <Button
                variant="danger"
                size="sm"
                data-testid="google-disconnect"
                onClick={() => setConfirmDisconnect(true)}
              >
                {t("google.disconnect")}
              </Button>
            </div>
          </>
        ) : null}
        {!compact && needsReconnect ? (
          <div className="border-t border-line pt-3">
            <Button
              variant="danger"
              size="sm"
              data-testid="google-disconnect"
              onClick={() => setConfirmDisconnect(true)}
            >
              {t("google.disconnect")}
            </Button>
          </div>
        ) : null}
      </Card>

      {babyId ? (
        <GoogleImportSheet
          open={sheetOpen}
          babyId={babyId}
          batchId={batchId}
          starting={starting}
          startError={startError}
          manualPickerUrl={manualUrl}
          contributor={contributor}
          onClose={closeSheet}
          onAgain={() => {
            closeSheet();
            window.setTimeout(() => void start(), 350);
          }}
        />
      ) : null}
      <IonAlert
        isOpen={confirmDisconnect}
        header={t("google.disconnectConfirm.title")}
        message={t("google.disconnectConfirm.body")}
        onWillDismiss={() => setConfirmDisconnect(false)}
        buttons={[
          { text: t("common.cancel"), role: "cancel" },
          {
            text: t("google.disconnectConfirm.action"),
            role: "destructive",
            handler: () => void disconnect(),
          },
        ]}
      />
    </>
  );
}
