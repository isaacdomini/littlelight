import {
  IonApp,
  IonIcon,
  IonLabel,
  IonRouterOutlet,
  IonTabBar,
  IonTabButton,
  IonTabs,
} from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { addCircle, chatbubbleEllipses, flag, images, people } from "ionicons/icons";
import { type ReactNode, useState } from "react";
import { Route, useLocation } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { FreshSignInProvider } from "./auth/FreshSignInGate";
import { RedirectIfSignedIn, RequireAuth, RequireOnboarded, RootRedirect } from "./auth/guards";
import { t } from "./i18n";
import { ApiError } from "./lib/api";
import { CallbackPage } from "./pages/auth/CallbackPage";
import { VerifyPage } from "./pages/auth/VerifyPage";
import { WelcomePage } from "./pages/auth/WelcomePage";
import { ChatPage } from "./pages/ChatPage";
import { FamilyPage } from "./pages/FamilyPage";
import { InvitePage } from "./pages/InvitePage";
import { LegalPage } from "./pages/LegalPage";
import { MilestonesPage } from "./pages/MilestonesPage";
import { BabyPage } from "./pages/onboarding/BabyPage";
import { ConsentPage } from "./pages/onboarding/ConsentPage";
import { FirstUploadPage } from "./pages/onboarding/FirstUploadPage";
import { InviteCoParentPage } from "./pages/onboarding/InviteCoParentPage";
import { PlanPage } from "./pages/onboarding/PlanPage";
import { ProfilePage } from "./pages/onboarding/ProfilePage";
import { AccountPage } from "./pages/settings/AccountPage";
import { DevicesPage } from "./pages/settings/DevicesPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { TimelinePage } from "./pages/TimelinePage";
import { UploadPage } from "./pages/UploadPage";

const TAB_ROUTES = ["/chat", "/timeline", "/upload", "/milestones", "/family", "/settings"];

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, e) =>
          e instanceof ApiError && e.status > 0 && e.status < 500 ? false : count < 2,
      },
    },
  });
}

/** Tab bar stays mounted (Ionic requires it inside IonTabs) but is hidden outside the app. */
function TabBar() {
  const { pathname } = useLocation();
  const visible = TAB_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return (
    <IonTabBar slot="bottom" style={visible ? undefined : { display: "none" }}>
      <IonTabButton tab="chat" href="/chat">
        <IonIcon aria-hidden icon={chatbubbleEllipses} />
        <IonLabel>{t("tabs.chat")}</IonLabel>
      </IonTabButton>
      <IonTabButton tab="timeline" href="/timeline">
        <IonIcon aria-hidden icon={images} />
        <IonLabel>{t("tabs.timeline")}</IonLabel>
      </IonTabButton>
      <IonTabButton tab="upload" href="/upload">
        <IonIcon aria-hidden icon={addCircle} />
        <IonLabel>{t("tabs.upload")}</IonLabel>
      </IonTabButton>
      <IonTabButton tab="milestones" href="/milestones">
        <IonIcon aria-hidden icon={flag} />
        <IonLabel>{t("tabs.milestones")}</IonLabel>
      </IonTabButton>
      <IonTabButton tab="family" href="/family">
        <IonIcon aria-hidden icon={people} />
        <IonLabel>{t("tabs.family")}</IonLabel>
      </IonTabButton>
    </IonTabBar>
  );
}

const app = (path: string, page: ReactNode, allowNoBaby = false) => (
  <RequireOnboarded path={path} allowNoBaby={allowNoBaby}>
    {page}
  </RequireOnboarded>
);
const flow = (path: string, page: ReactNode) => <RequireAuth path={path}>{page}</RequireAuth>;

export function App() {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <IonApp>
          <IonReactRouter>
            <FreshSignInProvider>
              <IonTabs>
                <IonRouterOutlet>
                  {/* public */}
                  <Route
                    path="/welcome"
                    element={
                      <RedirectIfSignedIn path="/welcome">
                        <WelcomePage />
                      </RedirectIfSignedIn>
                    }
                  />
                  <Route path="/verify" element={<VerifyPage />} />
                  <Route path="/signin/callback" element={<CallbackPage />} />
                  <Route path="/invite/:token" element={<InvitePage />} />
                  <Route path="/legal/terms" element={<LegalPage kind="terms" />} />
                  <Route path="/legal/privacy" element={<LegalPage kind="privacy" />} />
                  {/* onboarding */}
                  <Route
                    path="/onboarding/consent"
                    element={flow("/onboarding/consent", <ConsentPage />)}
                  />
                  <Route
                    path="/onboarding/profile"
                    element={flow("/onboarding/profile", <ProfilePage />)}
                  />
                  <Route path="/onboarding/baby" element={flow("/onboarding/baby", <BabyPage />)} />
                  <Route
                    path="/onboarding/invite"
                    element={flow("/onboarding/invite", <InviteCoParentPage />)}
                  />
                  <Route path="/onboarding/plan" element={flow("/onboarding/plan", <PlanPage />)} />
                  <Route
                    path="/onboarding/first-upload"
                    element={flow("/onboarding/first-upload", <FirstUploadPage />)}
                  />
                  {/* app */}
                  <Route path="/chat" element={app("/chat", <ChatPage />)} />
                  <Route path="/timeline" element={app("/timeline", <TimelinePage />)} />
                  <Route path="/upload" element={app("/upload", <UploadPage />)} />
                  <Route path="/milestones" element={app("/milestones", <MilestonesPage />)} />
                  <Route path="/family" element={app("/family", <FamilyPage />)} />
                  <Route path="/settings" element={app("/settings", <SettingsPage />, true)} />
                  <Route
                    path="/settings/devices"
                    element={app("/settings/devices", <DevicesPage />, true)}
                  />
                  <Route
                    path="/settings/account"
                    element={app("/settings/account", <AccountPage />, true)}
                  />
                  <Route path="/" element={<RootRedirect />} />
                </IonRouterOutlet>
                <TabBar />
              </IonTabs>
            </FreshSignInProvider>
          </IonReactRouter>
        </IonApp>
      </AuthProvider>
    </QueryClientProvider>
  );
}
