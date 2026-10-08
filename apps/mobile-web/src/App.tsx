import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { addCircle, chatbubbleEllipses, flag, images, people } from "ionicons/icons";
import { Navigate, Route } from "react-router-dom";
import { ChatPage } from "./pages/ChatPage";
import { FamilyPage } from "./pages/FamilyPage";
import { MilestonesPage } from "./pages/MilestonesPage";
import { TimelinePage } from "./pages/TimelinePage";
import { UploadPage } from "./pages/UploadPage";

export function App() {
  return (
    <IonReactRouter>
      <IonTabs>
        <IonRouterOutlet>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/milestones" element={<MilestonesPage />} />
          <Route path="/family" element={<FamilyPage />} />
          <Route path="/" element={<Navigate to="/chat" replace />} />
        </IonRouterOutlet>
        <IonTabBar slot="bottom">
          <IonTabButton tab="chat" href="/chat">
            <IonIcon aria-hidden icon={chatbubbleEllipses} />
            <IonLabel>Chat</IonLabel>
          </IonTabButton>
          <IonTabButton tab="timeline" href="/timeline">
            <IonIcon aria-hidden icon={images} />
            <IonLabel>Timeline</IonLabel>
          </IonTabButton>
          <IonTabButton tab="upload" href="/upload">
            <IonIcon aria-hidden icon={addCircle} />
            <IonLabel>Upload</IonLabel>
          </IonTabButton>
          <IonTabButton tab="milestones" href="/milestones">
            <IonIcon aria-hidden icon={flag} />
            <IonLabel>Milestones</IonLabel>
          </IonTabButton>
          <IonTabButton tab="family" href="/family">
            <IonIcon aria-hidden icon={people} />
            <IonLabel>Family</IonLabel>
          </IonTabButton>
        </IonTabBar>
      </IonTabs>
    </IonReactRouter>
  );
}
