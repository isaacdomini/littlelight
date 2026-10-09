import { IonContent, IonPage } from "@ionic/react";
import { AppHeader } from "../components/AppHeader";
import { ChatPanel } from "../components/chat/ChatPanel";
import { t } from "../i18n";

/** Home tab: chat with the album (admins of paid babies; gated notices otherwise). */
export function ChatPage() {
  return (
    <IonPage>
      <AppHeader title={t("tabs.chat")} />
      <IonContent scrollY={false}>
        <div className="mx-auto h-full w-full max-w-3xl">
          <ChatPanel variant="page" />
        </div>
      </IonContent>
    </IonPage>
  );
}
