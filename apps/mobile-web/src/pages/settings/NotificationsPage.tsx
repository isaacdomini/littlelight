import { useQueryClient } from "@tanstack/react-query";
import { type MeResponse, meResponseSchema, type ProfileUpdate } from "@tinyglow/shared";
import { useCallback, useEffect, useState } from "react";
import { ME_KEY, useAuth } from "../../auth/AuthProvider";
import { SubPage } from "../../components/Page";
import { Button, Card, CheckField, Message } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage } from "../../lib/api";
import { isNative } from "../../platform/platform";

type Permission = "granted" | "denied" | "prompt" | "unavailable";

/** Whether the signed-in user can receive any push at all (admins only; contributors get none). */
export function usePushKinds(): { shareViewed: boolean; photosAnalyzed: boolean } {
  const { me } = useAuth();
  const admin = (me?.babies ?? []).filter((b) => b.role === "admin");
  return {
    shareViewed: admin.length > 0,
    photosAnalyzed: admin.some((b) => b.plan !== "free"),
  };
}

/**
 * Settings -> Notifications (native only; docs/plans/step-9.md 2.8). Opt-in: nothing is asked
 * until "Turn on notifications". Two preference toggles live on the profile; a missing value
 * means on. Contributors never see this page's toggles (they receive no push).
 */
export function NotificationsPage() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const kinds = usePushKinds();
  const [permission, setPermission] = useState<Permission | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isNative()) return setPermission("unavailable");
    try {
      // pushPermission() settles within its own timeout; a failed chunk load must not leave
      // the page stuck on "loading" either.
      const { pushPermission } = await import("../../platform/native/push");
      setPermission(await pushPermission());
    } catch {
      setPermission("unavailable");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const { enablePush } = await import("../../platform/native/push");
      const result = await enablePush();
      if (result === "failed") setError(t("push.settings.failed"));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function setPref(change: ProfileUpdate) {
    setError(null);
    try {
      const updated = await apiFetch<MeResponse>("/me/profile", {
        method: "PATCH",
        body: change,
        schema: meResponseSchema,
      });
      qc.setQueryData(ME_KEY, updated);
    } catch (e) {
      setError(errorMessage(e) || t("push.settings.saveError"));
    }
  }

  const profile = me?.profile;
  const photosOn = profile?.notifyPhotosAnalyzed ?? true;
  const shareOn = profile?.notifyShareViewed ?? true;
  const canToggle = kinds.shareViewed || kinds.photosAnalyzed;

  return (
    <SubPage title={t("push.settings.title")} backHref="/settings">
      <div className="flex flex-col gap-4" data-testid="notifications">
        <p className="text-muted">{t("push.settings.intro")}</p>
        {error ? <Message data-testid="notifications-error">{error}</Message> : null}

        {permission === "unavailable" ? (
          <Card data-testid="notifications-unavailable">
            <p>{t("push.settings.unavailable")}</p>
          </Card>
        ) : permission === "granted" ? (
          <p className="text-sm text-muted" role="status" data-testid="notifications-on">
            {t("push.settings.enabled")}
          </p>
        ) : permission === "denied" ? (
          <Card data-testid="notifications-denied">
            <p>{t("push.settings.denied")}</p>
          </Card>
        ) : permission === "prompt" ? (
          <Button data-testid="notifications-enable" disabled={busy} onClick={() => void enable()}>
            {t("push.settings.enable")}
          </Button>
        ) : null}

        {canToggle && permission !== "unavailable" ? (
          <Card className="flex flex-col gap-4" data-testid="notifications-prefs">
            <h2 className="text-sm font-semibold text-muted">{t("push.settings.kinds")}</h2>
            {kinds.photosAnalyzed ? (
              <div className="flex flex-col gap-1">
                <CheckField
                  data-testid="notify-photos-analyzed"
                  label={t("push.settings.photosAnalyzed")}
                  checked={photosOn}
                  onChange={(e) => void setPref({ notifyPhotosAnalyzed: e.target.checked })}
                />
                <p className="ll-hint pl-9">{t("push.settings.photosAnalyzedHint")}</p>
              </div>
            ) : null}
            {kinds.shareViewed ? (
              <div className="flex flex-col gap-1">
                <CheckField
                  data-testid="notify-share-viewed"
                  label={t("push.settings.shareViewed")}
                  checked={shareOn}
                  onChange={(e) => void setPref({ notifyShareViewed: e.target.checked })}
                />
                <p className="ll-hint pl-9">{t("push.settings.shareViewedHint")}</p>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </SubPage>
  );
}
