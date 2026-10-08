import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import type { ReactNode } from "react";

/** Centered single-column page for sign-in / onboarding screens (no tab bar, no switcher). */
export function FlowPage({
  title,
  subtitle,
  children,
  testId,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <IonPage>
      <IonContent className="ion-padding">
        <main
          className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-5 py-6"
          data-testid={testId}
        >
          <header className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold">{title}</h1>
            {subtitle ? <p className="opacity-80">{subtitle}</p> : null}
          </header>
          {children}
        </main>
      </IonContent>
    </IonPage>
  );
}

/** App sub-page with a back button (settings, devices, account, legal). */
export function SubPage({
  title,
  backHref,
  children,
}: {
  title: string;
  backHref: string;
  children: ReactNode;
}) {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref={backHref} />
          </IonButtons>
          <IonTitle>{title}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">{children}</div>
      </IonContent>
    </IonPage>
  );
}
