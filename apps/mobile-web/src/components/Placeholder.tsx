import { IonContent, IonPage } from "@ionic/react";
import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader";

export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <IonPage>
      <AppHeader title={title} />
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <p className="text-muted">{title} is coming soon.</p>
          {children}
        </div>
      </IonContent>
    </IonPage>
  );
}
