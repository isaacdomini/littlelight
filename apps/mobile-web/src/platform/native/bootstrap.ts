import { nativePlatform } from "../platform";
import { setTokenStore } from "../tokenStore";
import { setUploader } from "../uploader";
import { nativeUploader } from "./nativeUploader";
import { createSecureTokenStore } from "./secureTokenStore";
import { refreshIfNeeded } from "./session";
import { syncMayBeOn } from "./syncFlag";
import { hideSplash, syncStatusBar } from "./ui";

/**
 * One-time native wiring, awaited by `main.tsx` before the first render (native only; the module
 * is a lazy chunk, so the web bundle never loads it): Keychain/Keystore token store, background
 * uploader, launch-time token refresh. Never throws.
 */
export async function bootstrapNative(): Promise<void> {
  setTokenStore(createSecureTokenStore());
  setUploader(nativeUploader);
  if (nativePlatform() === "ios" && syncMayBeOn()) {
    // Album sync (iOS): listen for background refreshes. Lazy and fire-and-forget, so a missing
    // plugin or a slow Keychain never delays the first render.
    void import("./photoSync").then((m) => m.photoSync.init()).catch(() => undefined);
  }
  try {
    await refreshIfNeeded();
  } catch {
    // offline at launch: the first API call refreshes on demand
  }
}

/**
 * After the first render: reveal the app (splash is `launchAutoHide: false`), style the bar, then
 * tell the live updater this web bundle booted (cancels its rollback watchdog, docs/plans/step-14.md
 * 2.7). Both entry paths (signed-in app and share viewer) reach this from `main.tsx`. Never throws.
 */
export async function afterFirstRender(): Promise<void> {
  try {
    await syncStatusBar();
    await hideSplash();
  } finally {
    void import("./appUpdate").then((m) => m.notifyAppReady()).catch(() => undefined);
  }
}
