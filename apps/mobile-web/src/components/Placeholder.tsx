import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from "@ionic/react";
import type { ReactNode } from "react";

export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{title}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <p className="opacity-70">{title} is coming soon.</p>
          {children}
        </div>
      </IonContent>
    </IonPage>
  );
}
