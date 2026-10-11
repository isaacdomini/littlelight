import { IonContent, IonPage } from "@ionic/react";
import { SUPPORT_EMAIL } from "@tinyglow/shared";
import type { ReactNode } from "react";
import { useSignOut } from "../auth/useSignOut";
import { t } from "../i18n";
import { clearSuspended, useSuspended } from "../lib/suspended";
import { LogoMark } from "./Logo";
import { Button } from "./ui";

/** Shown instead of the app when the API answers `account_suspended`. Calm, one way out. */
function SuspendedScreen() {
  const signOut = useSignOut();
  return (
    <IonPage>
      <IonContent className="ion-padding">
        <main
          className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 py-8"
          data-testid="suspended"
        >
          <LogoMark className="h-10 w-10" />
          <header className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">{t("suspended.title")}</h1>
            <p className="text-muted">{t("suspended.body", { support: SUPPORT_EMAIL })}</p>
          </header>
          <a
            className="ll-btn ll-btn-primary"
            data-testid="suspended-contact"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            {t("suspended.contact")}
          </a>
          <Button
            variant="secondary"
            data-testid="suspended-signout"
            onClick={() => void signOut("local").finally(clearSuspended)}
          >
            {t("suspended.signOut")}
          </Button>
        </main>
      </IonContent>
    </IonPage>
  );
}

export function SuspendedGate({ children }: { children: ReactNode }) {
  return useSuspended() ? <SuspendedScreen /> : children;
}
