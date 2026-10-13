import { IonAlert } from "@ionic/react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { SubPage } from "../../components/Page";
import { Button, Card, Message, Tag } from "../../components/ui";
import { type MessageKey, t } from "../../i18n";
import { summarize, uploadManager } from "../../lib/upload/manager";
import {
  type AppUpdateOutcome,
  appUpdateStatus,
  WEB_VERSION,
} from "../../platform/native/appUpdateStatus";
import { photoSync } from "../../platform/native/photoSync";
import { isNative, nativePlatform } from "../../platform/platform";

// Settings -> About (docs/plans/step-14.md 2.8). Web: the build's version only. Native: the shell
// version, the running web bundle (bundled or updated), "Update ready — restart to apply" with a
// Restart that waits for uploads and album sync, a manual "Check for updates" and "Reset app
// files". The updater client is a lazy native chunk (`import("…/appUpdate")`).

const updater = () => import("../../platform/native/appUpdate");

/** True while an upload (any lane) or an album sync run is in progress. */
function useBusy(): boolean {
  const items = useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);
  const sync = useSyncExternalStore(photoSync.subscribe, photoSync.getStatus);
  return summarize(items).active > 0 || (nativePlatform() === "ios" && sync.phase === "syncing");
}

function outcomeKey(o: AppUpdateOutcome): MessageKey | null {
  switch (o) {
    case "up_to_date":
      return "appUpdate.outcome.up_to_date";
    case "disabled":
    case "unavailable":
    case "rejected":
      return "appUpdate.outcome.none";
    case "wifi_required":
      return "appUpdate.outcome.wifi_required";
    case "constrained":
      return "appUpdate.outcome.constrained";
    case "native_too_old":
      return nativePlatform() === "android"
        ? "appUpdate.outcome.native_too_old.android"
        : "appUpdate.outcome.native_too_old.ios";
    case "no_space":
      return "appUpdate.outcome.no_space";
    case "verify_failed":
      return "appUpdate.outcome.verify_failed";
    case "busy":
      return "appUpdate.outcome.busy";
    case "network":
    case "error":
      return "appUpdate.outcome.failed";
    default:
      // staged / already_staged: the "Update ready" block says it
      return null;
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 flex-col items-end gap-1 text-right">{children}</span>
    </li>
  );
}

function WebAbout() {
  return (
    <>
      <ul className="ll-list">
        <Row label={t("appUpdate.web")}>
          <span data-testid="about-web-version">{WEB_VERSION}</span>
        </Row>
      </ul>
      <p className="ll-hint">{t("appUpdate.webHint")}</p>
    </>
  );
}

function NativeAbout() {
  const status = useSyncExternalStore(appUpdateStatus.subscribe, appUpdateStatus.get);
  const busy = useBusy();
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void updater()
      .then((m) => m.updaterInfo({ fresh: true }))
      .catch(() => undefined);
  }, []);

  const info = status.info;
  const staged = Boolean(info?.stagedVersion) && info?.stagedVersion !== info?.currentVersion;
  const inFlight = status.phase !== "idle";
  const outcome = status.outcome ? outcomeKey(status.outcome) : null;
  const hasOta = info?.currentSource === "ota" || staged;

  const check = () => {
    setError(null);
    void updater()
      .then((m) => m.checkForUpdate("manual"))
      .catch(() => appUpdateStatus.set({ phase: "idle", outcome: "error" }));
  };
  const restart = async () => {
    setError(null);
    setWorking(true);
    try {
      const r = await (await updater()).appUpdater.applyNow();
      if (r === "failed") setError(t("appUpdate.restartFailed"));
    } catch {
      setError(t("appUpdate.restartFailed"));
    } finally {
      setWorking(false);
    }
  };
  const reset = async () => {
    setError(null);
    setWorking(true);
    try {
      if (!(await (await updater()).appUpdater.reset())) setError(t("appUpdate.resetFailed"));
    } catch {
      setError(t("appUpdate.resetFailed"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <ul className="ll-list" data-testid="about-versions">
        {info ? (
          <Row label={t("appUpdate.app")}>
            <span data-testid="about-app-version">
              {t("appUpdate.appValue", { version: info.nativeVersion, build: info.nativeBuild })}
            </span>
          </Row>
        ) : null}
        <Row label={t("appUpdate.web")}>
          <span className="flex items-center gap-2">
            {info ? (
              <Tag data-testid="about-source" data-source={info.currentSource}>
                {t(
                  info.currentSource === "ota"
                    ? "appUpdate.source.ota"
                    : "appUpdate.source.builtin",
                )}
              </Tag>
            ) : null}
            <span data-testid="about-web-version">{WEB_VERSION}</span>
          </span>
          {info ? (
            <span className="ll-caption break-all font-mono" data-testid="about-bundle-id">
              {info.currentVersion}
            </span>
          ) : null}
        </Row>
      </ul>

      {error ? <Message data-testid="about-error">{error}</Message> : null}

      {staged ? (
        <Card className="flex flex-col gap-3" data-testid="about-ready">
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{t("appUpdate.ready")}</p>
            <p className="ll-hint">
              {busy ? t("appUpdate.restartBusy") : t("appUpdate.readyHint")}
            </p>
          </div>
          <Button
            data-testid="about-restart"
            disabled={busy || working}
            onClick={() => void restart()}
          >
            {t("appUpdate.restart")}
          </Button>
        </Card>
      ) : null}

      {info ? (
        <div className="flex flex-col gap-2">
          <Button
            variant={staged ? "secondary" : "primary"}
            data-testid="about-check"
            disabled={inFlight || working}
            onClick={check}
          >
            {t("appUpdate.check")}
          </Button>
          <div aria-live="polite">
            {inFlight ? (
              <p className="ll-hint" data-testid="about-outcome" data-outcome={status.phase}>
                {t(status.phase === "downloading" ? "appUpdate.downloading" : "appUpdate.checking")}
              </p>
            ) : outcome && status.outcome ? (
              <p className="ll-hint" data-testid="about-outcome" data-outcome={status.outcome}>
                {t(outcome)}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {hasOta ? (
        <Button
          variant="danger"
          data-testid="about-reset"
          disabled={working || inFlight || busy}
          onClick={() => setConfirmReset(true)}
        >
          {t("appUpdate.reset")}
        </Button>
      ) : null}

      <IonAlert
        isOpen={confirmReset}
        header={t("appUpdate.resetTitle")}
        message={t("appUpdate.resetBody")}
        onDidDismiss={() => setConfirmReset(false)}
        buttons={[
          { text: t("common.cancel"), role: "cancel" },
          {
            text: t("appUpdate.resetConfirm"),
            role: "destructive",
            handler: () => {
              void reset();
            },
          },
        ]}
      />
    </>
  );
}

export function AboutPage() {
  return (
    <SubPage title={t("appUpdate.title")} backHref="/settings">
      <div className="flex flex-col gap-4" data-testid="about">
        {isNative() ? <NativeAbout /> : <WebAbout />}
      </div>
    </SubPage>
  );
}
