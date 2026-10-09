import { IonContent, IonIcon, IonPage } from "@ionic/react";
import { chevronForward } from "ionicons/icons";
import { useNavigate } from "react-router-dom";
import { useSignOut } from "../../auth/useSignOut";
import { AppHeader } from "../../components/AppHeader";
import { Button } from "../../components/ui";
import { t } from "../../i18n";
import { isNative } from "../../platform/platform";
import { usePushKinds } from "./NotificationsPage";

export function SettingsPage() {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const native = isNative();
  const kinds = usePushKinds();
  const rows: (readonly [string, string, string])[] = [
    ...(native && (kinds.shareViewed || kinds.photosAnalyzed)
      ? ([["settings-notifications", "/settings/notifications", t("push.settings.row")]] as const)
      : []),
    ["settings-devices", "/settings/devices", t("settings.devices")],
    // Account deletion must be easy to find in the app (App Store 5.1.1(v)).
    [
      "settings-account",
      "/settings/account",
      native ? t("native.settings.deleteAccount") : t("settings.account"),
    ],
  ];
  return (
    <IonPage>
      <AppHeader title={t("settings.title")} />
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" data-testid="settings">
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
