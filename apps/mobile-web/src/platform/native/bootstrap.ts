import { setTokenStore } from "../tokenStore";
import { setUploader } from "../uploader";
import { nativeUploader } from "./nativeUploader";
import { createSecureTokenStore } from "./secureTokenStore";
import { refreshIfNeeded } from "./session";
import { hideSplash, syncStatusBar } from "./ui";

/**
 * One-time native wiring, awaited by `main.tsx` before the first render (native only; the module
 * is a lazy chunk, so the web bundle never loads it): Keychain/Keystore token store, background
 * uploader, launch-time token refresh. Never throws.
 */
export async function bootstrapNative(): Promise<void> {
  setTokenStore(createSecureTokenStore());
  setUploader(nativeUploader);
  try {
    await refreshIfNeeded();
  } catch {
    // offline at launch: the first API call refreshes on demand
  }
}

/** After the first render: reveal the app (splash is `launchAutoHide: false`) and style the bar. */
export async function afterFirstRender(): Promise<void> {
  await syncStatusBar();
  await hideSplash();
}
