import { IonContent, IonIcon, IonPage } from "@ionic/react";
import { chevronForward } from "ionicons/icons";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { useSignOut } from "../../auth/useSignOut";
import { AppHeader } from "../../components/AppHeader";
import { FreeTierNotice } from "../../components/FreeTierNotice";
import { Button } from "../../components/ui";
import { t } from "../../i18n";
import { useGoogleConnection } from "../../lib/googleImport";
import { usePasskeySupport } from "../../lib/passkeys";
import { useAppleSyncAvailable } from "../../lib/queries/imports";
import { isNative } from "../../platform/platform";
import { usePushKinds } from "./NotificationsPage";

export function SettingsPage() {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const native = isNative();
  const kinds = usePushKinds();
  const { baby } = useCurrentBaby();
  const appleSync = useAppleSyncAvailable();
  // Google import: any member who can add photos, when the server offers it.
  const google = useGoogleConnection(baby?.role === "admin" || baby?.role === "contributor");
  const googleImport = google.data?.available === true;
  const passkeys = usePasskeySupport();
  const rows: (readonly [string, string, string])[] = [
    ...(native && (kinds.shareViewed || kinds.photosAnalyzed)
      ? ([["settings-notifications", "/settings/notifications", t("push.settings.row")]] as const)
      : []),
    // Photo import: Google (admins and contributors) and Apple album sync (iPhone admins). The API
    // enforces the roles too.
    ...(appleSync || googleImport
      ? ([["settings-import", "/settings/import", t("settings.import")]] as const)
      : []),
    // Data export is admin-only (the API enforces it too).
    ...(baby?.role === "admin"
      ? ([["settings-export", "/settings/export", t("settings.export")]] as const)
      : []),
    // Passkeys (step 13): only when the server offers them and this device can use them.
    ...(passkeys.enabled === true
      ? ([["settings-passkeys", "/settings/passkeys", t("passkey.settings.row")]] as const)
      : []),
    ["settings-devices", "/settings/devices", t("settings.devices")],
    // Native: how large videos leave the phone (step 12 Q6 follow-up).
    ...(native
      ? ([["settings-uploads", "/settings/uploads", t("settings.uploads")]] as const)
      : []),
    // Account deletion must be easy to find in the app (App Store 5.1.1(v)).
    [
      "settings-account",
      "/settings/account",
      native ? t("native.settings.deleteAccount") : t("settings.account"),
    ],
    // Versions, and on the apps the live-update status (step 14).
    ["settings-about", "/settings/about", t("settings.about")],
  ];
  return (
    <IonPage>
      <AppHeader title={t("settings.title")} />
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" data-testid="settings">
          {baby ? <FreeTierNotice baby={baby} /> : null}
          <ul className="ll-list">
            {rows.map(([testId, to, label]) => (
              <li key={testId} className="!p-0">
                <button
                  type="button"
                  data-testid={testId}
                  onClick={() => navigate(to)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left"
                >
                  <span>{label}</span>
                  <IonIcon icon={chevronForward} aria-hidden className="h-5 w-5 text-muted" />
                </button>
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            data-testid="signout-local"
            onClick={() => void signOut("local")}
          >
            {t("settings.signOut")}
          </Button>
        </div>
      </IonContent>
    </IonPage>
  );
}
