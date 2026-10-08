import { IonContent, IonItem, IonLabel, IonList, IonPage } from "@ionic/react";
import { useNavigate } from "react-router-dom";
import { useSignOut } from "../../auth/useSignOut";
import { AppHeader } from "../../components/AppHeader";
import { Button } from "../../components/ui";
import { t } from "../../i18n";

export function SettingsPage() {
  const navigate = useNavigate();
  const signOut = useSignOut();
  return (
    <IonPage>
      <AppHeader title={t("settings.title")} />
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4" data-testid="settings">
          <IonList inset>
            <IonItem
              button
              detail
              data-testid="settings-devices"
              onClick={() => navigate("/settings/devices")}
              className="min-h-11"
            >
              <IonLabel>{t("settings.devices")}</IonLabel>
            </IonItem>
            <IonItem
              button
              detail
              data-testid="settings-account"
              onClick={() => navigate("/settings/account")}
              className="min-h-11"
            >
              <IonLabel>{t("settings.account")}</IonLabel>
            </IonItem>
          </IonList>
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
