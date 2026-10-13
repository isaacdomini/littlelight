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
import {
  addCircle,
  addCircleOutline,
  chatbubbleEllipses,
  chatbubbleEllipsesOutline,
  flag,
  flagOutline,
  images,
  imagesOutline,
  people,
  peopleOutline,
} from "ionicons/icons";
import { type ReactNode, useState } from "react";
import { Route, useLocation } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { FreshSignInProvider } from "./auth/FreshSignInGate";
import { RedirectIfSignedIn, RequireAuth, RequireOnboarded, RootRedirect } from "./auth/guards";
import { PasskeyPrompt } from "./components/PasskeyPrompt";
import { SuspendedGate } from "./components/SuspendedGate";
import { ShareExpired } from "./components/share/ShareExpired";
import { t } from "./i18n";
import { ApiError } from "./lib/api";
import { CallbackPage } from "./pages/auth/CallbackPage";
import { NativeSignInPage } from "./pages/auth/NativeSignInPage";
import { VerifyPage } from "./pages/auth/VerifyPage";
import { WelcomePage } from "./pages/auth/WelcomePage";
import { ChatPage } from "./pages/ChatPage";
import { FamilyPage } from "./pages/FamilyPage";
import { InvitePage } from "./pages/InvitePage";
import { GoogleConnectedPage, isGoogleConnectedPath } from "./pages/import/GoogleConnectedPage";
import { LegalPage } from "./pages/LegalPage";
import { MilestonesPage } from "./pages/MilestonesPage";
import { BabyPage } from "./pages/onboarding/BabyPage";
import { ConsentPage } from "./pages/onboarding/ConsentPage";
import { FirstUploadPage } from "./pages/onboarding/FirstUploadPage";
import { InviteCoParentPage } from "./pages/onboarding/InviteCoParentPage";
import { PlanPage } from "./pages/onboarding/PlanPage";
import { ProfilePage } from "./pages/onboarding/ProfilePage";
import { ShareLinkPhotosPage } from "./pages/ShareLinkPhotosPage";
import { AboutPage } from "./pages/settings/AboutPage";
import { AccountPage } from "./pages/settings/AccountPage";
import { DevicesPage } from "./pages/settings/DevicesPage";
import { ExportPage } from "./pages/settings/ExportPage";
import { ImportPage } from "./pages/settings/ImportPage";
import { NotificationsPage } from "./pages/settings/NotificationsPage";
import { PasskeysPage } from "./pages/settings/PasskeysPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { UploadsPage } from "./pages/settings/UploadsPage";
import { SharedAlbumPage } from "./pages/share/SharedAlbumPage";
import { TimelinePage } from "./pages/TimelinePage";
import { UploadPage } from "./pages/UploadPage";
import { NativeEvents, NativeViewerEvents } from "./platform/native/NativeEvents";
import { isNative } from "./platform/platform";

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

const TABS = [
  { tab: "chat", icon: chatbubbleEllipsesOutline, active: chatbubbleEllipses },
  { tab: "timeline", icon: imagesOutline, active: images },
  { tab: "upload", icon: addCircleOutline, active: addCircle },
  { tab: "milestones", icon: flagOutline, active: flag },
  { tab: "family", icon: peopleOutline, active: people },
] as const;

/** Tab bar stays mounted (Ionic requires it inside IonTabs) but is hidden outside the app. */
function TabBar() {
  const { pathname } = useLocation();
  const visible = TAB_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return (
    <IonTabBar slot="bottom" style={visible ? undefined : { display: "none" }}>
      {TABS.map(({ tab, icon, active }) => (
        <IonTabButton key={tab} tab={tab} href={`/${tab}`}>
          <IonIcon
            aria-hidden
            icon={pathname === `/${tab}` || pathname.startsWith(`/${tab}/`) ? active : icon}
          />
          <IonLabel>{t(`tabs.${tab}`)}</IonLabel>
        </IonTabButton>
      ))}
    </IonTabBar>
  );
}

const app = (path: string, page: ReactNode, allowNoBaby = false) => (
  <RequireOnboarded path={path} allowNoBaby={allowNoBaby}>
    {page}
  </RequireOnboarded>
);
const flow = (path: string, page: ReactNode) => <RequireAuth path={path}>{page}</RequireAuth>;

function ParentApp() {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <IonApp>
          <IonReactRouter>
            <FreshSignInProvider>
              {isNative() && <NativeEvents />}
              <SuspendedGate>
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
                    <Route path="/signin/native" element={<NativeSignInPage />} />
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
                    <Route
                      path="/onboarding/baby"
                      element={flow("/onboarding/baby", <BabyPage />)}
                    />
                    <Route
                      path="/onboarding/invite"
                      element={flow("/onboarding/invite", <InviteCoParentPage />)}
                    />
                    <Route
                      path="/onboarding/plan"
                      element={flow("/onboarding/plan", <PlanPage />)}
                    />
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
                    <Route
                      path="/family/share/:linkId"
                      element={app("/family/share/:linkId", <ShareLinkPhotosPage />)}
                    />
                    <Route path="/settings" element={app("/settings", <SettingsPage />, true)} />
                    <Route
                      path="/settings/devices"
                      element={app("/settings/devices", <DevicesPage />, true)}
                    />
                    <Route
                      path="/settings/export"
                      element={app("/settings/export", <ExportPage />, true)}
                    />
                    <Route
                      path="/settings/import"
                      element={app("/settings/import", <ImportPage />, true)}
                    />
                    <Route
                      path="/settings/notifications"
                      element={app("/settings/notifications", <NotificationsPage />, true)}
                    />
                    <Route
                      path="/settings/account"
                      element={app("/settings/account", <AccountPage />, true)}
                    />
                    <Route
                      path="/settings/passkeys"
                      element={app("/settings/passkeys", <PasskeysPage />, true)}
                    />
                    <Route
                      path="/settings/uploads"
                      element={app("/settings/uploads", <UploadsPage />, true)}
                    />
                    <Route
                      path="/settings/about"
                      element={app("/settings/about", <AboutPage />, true)}
                    />
                    <Route path="/" element={<RootRedirect />} />
                  </IonRouterOutlet>
                  <TabBar />
                </IonTabs>
                <PasskeyPrompt />
              </SuspendedGate>
            </FreshSignInProvider>
          </IonReactRouter>
        </IonApp>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * `/s/:token` is the public family album: no AuthProvider (so no `/me` request), no router, no
 * tab bar. The token comes from the path and is only ever sent in the session exchange body.
 */
function ViewerApp({ token }: { token: string }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <IonApp>
        {isNative() && <NativeViewerEvents />}
        <SharedAlbumPage token={token} />
      </IonApp>
    </QueryClientProvider>
  );
}

const SHARE_PATH_RE = /^\/s\/([A-Za-z0-9_-]{22,64})\/?$/;

export function App() {
  const m = SHARE_PATH_RE.exec(window.location.pathname);
  if (isGoogleConnectedPath(window.location.pathname)) {
    return (
      <IonApp>
        <GoogleConnectedPage />
      </IonApp>
    );
  }
  if (window.location.pathname.startsWith("/s/")) {
    return m?.[1] ? <ViewerApp token={m[1]} /> : <ViewerExpired />;
  }
  return <ParentApp />;
}

/** A malformed `/s/…` path is the same friendly dead end as an expired link. */
function ViewerExpired() {
  return (
    <IonApp>
      <ShareExpired />
    </IonApp>
  );
}
