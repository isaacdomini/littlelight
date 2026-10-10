import { IonIcon } from "@ionic/react";
import { GOOGLE_CONNECTED_PATH, googleConnectedQuerySchema } from "@littlelight/shared";
import { checkmarkCircle, closeCircle } from "ionicons/icons";
import { useEffect } from "react";
import { FlowPage } from "../../components/Page";
import { Button } from "../../components/ui";
import { t } from "../../i18n";

/** True when this URL is the page the OAuth callback redirects to. */
export function isGoogleConnectedPath(pathname: string): boolean {
  return pathname.replace(/\/$/, "") === GOOGLE_CONNECTED_PATH;
}

/**
 * Where Google's consent ends (plan D15). It runs in the browser tab the consent opened (the
 * system browser on native), so it has no router, no session and makes no API call: the app
 * re-checks the connection itself when the user comes back. `returnTo` is parsed against the
 * allow-list (anything else is dropped) and only ever used as a same-origin path.
 */
export function GoogleConnectedPage() {
  const q = googleConnectedQuerySchema.parse(
    Object.fromEntries(new URLSearchParams(window.location.search)),
  );
  const ok = q.status === "ok";
  const native = q.client === "native";
  const returnTo = q.returnTo ?? "/upload";

  // Web: straight back into the app after a moment (the original tab also notices on focus).
  useEffect(() => {
    if (!ok || native) return;
    const id = window.setTimeout(() => window.location.replace(returnTo), 1800);
    return () => window.clearTimeout(id);
  }, [ok, native, returnTo]);

  const title =
    ok && native ? t("google.connected.title.okNative") : t(`google.connected.title.${q.status}`);
  const body =
    ok && native ? t("google.connected.body.okNative") : t(`google.connected.body.${q.status}`);

  return (
    <FlowPage title={title} subtitle={body} testId="google-connected-page">
      <div className="flex flex-col items-start gap-3">
        <span
          aria-hidden
          className={`flex h-12 w-12 items-center justify-center rounded-full bg-accent-tint ${ok ? "text-success-text" : "text-danger-text"}`}
        >
          <IonIcon icon={ok ? checkmarkCircle : closeCircle} className="h-7 w-7" />
        </span>
        {native ? (
          <p className="text-muted" data-testid="google-connected-native">
            {t("google.connected.closeHint")}
          </p>
        ) : (
          <Button
            data-testid="google-connected-back"
            onClick={() => window.location.assign(returnTo)}
          >
            {t("google.connected.back")}
          </Button>
        )}
      </div>
    </FlowPage>
  );
}
