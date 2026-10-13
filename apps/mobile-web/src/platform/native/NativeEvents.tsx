import type { PushData } from "@tinyglow/shared";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { isNative, nativePlatform } from "../platform";
import { toAppPath } from "./deepLinks";
import { onPushTap, refreshPushRegistration } from "./push";
import { refreshIfNeeded } from "./session";
import { syncMayBeOn } from "./syncFlag";

// Native app-level events (docs/plans/step-9.md 2.4, 2.5, 2.8). Renders nothing.
// - appUrlOpen / launch URL: allow-listed deep links only (`toAppPath`), never logged.
// - resume: refresh the session when the access token is near expiry, then a live-update check.
// - signed in: push token refresh, album sync, and a live-update check 10 s later (step 14).
// - Android back button: history back, else exit.
// - push taps: photos_analyzed => select baby, Chat; share_viewed => select baby, Family.

type Go = (path: string) => void;

/**
 * `/s/…` has no router (ViewerApp is chosen from the URL at load): reload into it. Already there:
 * nothing to do (a reload would only re-run the exchange).
 */
const hardNavigate: Go = (path) => {
  if (path === `${window.location.pathname}${window.location.search}`) return;
  window.location.assign(path);
};

// `App.getLaunchUrl()` is sticky for the whole process: iOS returns the last URL the app was opened
// with (`ApplicationDelegateProxy.lastURL`), Android the intent that started the activity. Every
// full-page load (the reload into `/s/…`, "Done" back to `/`, a retry) would route it again: the
// share link reloaded into itself forever (blank WebView). So a launch URL is handled once per
// WebView session; sessionStorage survives those reloads but not a new process. Only a 32-bit
// digest is kept, never the URL (it carries a token).
const LAUNCH_KEY = "ll.launch-url.v1";

function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** True the first time this WebView session sees `url` as its launch URL. */
function firstSightOfLaunchUrl(url: string): boolean {
  const d = digest(url);
  try {
    if (window.sessionStorage.getItem(LAUNCH_KEY) === d) return false;
    window.sessionStorage.setItem(LAUNCH_KEY, d);
  } catch {
    // storage unavailable: route it; hardNavigate's same-path check still stops a reload loop
  }
  return true;
}

/** Live updates (step 14): idle-only, rate-limited inside `checkForUpdate`. Fire-and-forget. */
function checkForUpdate(trigger: "launch" | "resume") {
  void import("./appUpdate").then((m) => m.checkForUpdate(trigger)).catch(() => undefined);
}

/** Delay of the launch check after sign-in, so it never competes with the first screen. */
const UPDATE_CHECK_DELAY_MS = 10_000;

/** Album sync (iOS only; does nothing unless a parent set it up on this phone). */
function syncNow(trigger: "launch" | "resume") {
  if (nativePlatform() !== "ios" || !syncMayBeOn()) return;
  void import("./photoSync").then((m) => m.photoSync.runSync(trigger)).catch(() => undefined);
}

function useAppEvents(go: Go, goPushTap: (data: PushData) => void) {
  const goRef = useRef(go);
  const tapRef = useRef(goPushTap);
  goRef.current = go;
  tapRef.current = goPushTap;

  useEffect(() => {
    if (!isNative()) return;
    let disposed = false;
    const handles: { remove: () => Promise<void> }[] = [];
    const route = (url: string) => {
      const path = toAppPath(url);
      if (path) goRef.current(path);
    };
    void (async () => {
      const { App } = await import("@capacitor/app");
      const add = async (h: Promise<{ remove: () => Promise<void> }>) => {
        const handle = await h;
        if (disposed) void handle.remove();
        else handles.push(handle);
      };
      await add(App.addListener("appUrlOpen", (e) => route(e.url)));
      await add(
        App.addListener("resume", () => {
          void refreshIfNeeded()
            .catch(() => undefined)
            .then(() => checkForUpdate("resume"));
          syncNow("resume");
        }),
      );
      await add(
        App.addListener("backButton", ({ canGoBack }) => {
          if (canGoBack) window.history.back();
          else void App.exitApp();
        }),
      );
      const launch = await App.getLaunchUrl();
      if (launch?.url && !disposed && firstSightOfLaunchUrl(launch.url)) route(launch.url);
    })().catch(() => undefined);
    const offTap = onPushTap((d) => tapRef.current(d));
    return () => {
      disposed = true;
      offTap();
      for (const h of handles) void h.remove();
    };
  }, []);
}

/** Inside the router + AuthProvider (signed-in app and onboarding). */
export function NativeEvents() {
  const navigate = useNavigate();
  const { setCurrentBabyId, me } = useAuth();
  const signedIn = Boolean(me);

  useAppEvents(
    (path) => (path.startsWith("/s/") ? hardNavigate(path) : navigate(path)),
    (data) => {
      setCurrentBabyId(data.babyId);
      navigate(data.kind === "photos_analyzed" ? "/chat" : "/family");
    },
  );

  useEffect(() => {
    if (!signedIn || !isNative()) return;
    void refreshPushRegistration().catch(() => undefined);
    syncNow("launch");
    const timer = setTimeout(() => checkForUpdate("launch"), UPDATE_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signedIn]);

  return null;
}

/** Inside the share viewer (no router, no auth): deep links reload into the target route. */
export function NativeViewerEvents() {
  useAppEvents(hardNavigate, () => undefined);
  return null;
}
