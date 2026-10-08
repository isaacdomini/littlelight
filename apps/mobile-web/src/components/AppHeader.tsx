import {
  IonButton,
  IonButtons,
  IonHeader,
  IonIcon,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { settingsOutline } from "ionicons/icons";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../auth/AuthProvider";
import { t } from "../i18n";

const ADD_BABY = "__add_baby__";

/** Header for every tab page: page title, baby switcher and a settings link. */
export function AppHeader({ title }: { title: string }) {
  const navigate = useNavigate();
  const { baby, babies, setCurrentBabyId } = useCurrentBaby();

  return (
    <IonHeader>
      <IonToolbar>
        <IonTitle>{title}</IonTitle>
        <IonButtons slot="end">
          <IonSelect
            data-testid="baby-switcher"
            aria-label={t("header.switcher")}
            interface="popover"
            value={baby?.id ?? null}
            placeholder={t("header.noBaby")}
            className="max-w-48"
            onIonChange={(e) => {
              const v = e.detail.value as string | null;
              if (v === ADD_BABY) {
                navigate("/onboarding/baby?another=1");
              } else if (v) {
                setCurrentBabyId(v);
              }
            }}
          >
            {babies.map((b) => (
              <IonSelectOption key={b.id} value={b.id}>
                {b.nickname ?? b.name}
              </IonSelectOption>
            ))}
            <IonSelectOption value={ADD_BABY}>{t("header.addBaby")}</IonSelectOption>
          </IonSelect>
          <IonButton
            data-testid="open-settings"
            aria-label={t("header.settings")}
            onClick={() => navigate("/settings")}
          >
            <IonIcon slot="icon-only" icon={settingsOutline} aria-hidden />
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>
  );
}
