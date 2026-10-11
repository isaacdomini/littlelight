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
import { LogoHorizontal } from "./Logo";

/** Centered single-column page for sign-in / onboarding screens (no tab bar, no switcher). */
export function FlowPage({
  title,
  subtitle,
  children,
  testId,
  brand = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testId?: string;
  /** Show the Tinyglow mark above the title (welcome). */
  brand?: boolean;
}) {
  return (
    <IonPage>
      <IonContent className="ion-padding">
        <main
          className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 py-8"
          data-testid={testId}
        >
          <header className="flex flex-col gap-2">
            {brand ? <LogoHorizontal className="mb-2 h-10" /> : null}
            <h1 className="text-2xl font-semibold">{title}</h1>
            {subtitle ? <p className="text-muted">{subtitle}</p> : null}
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
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">{children}</div>
      </IonContent>
    </IonPage>
  );
}
