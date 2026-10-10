import { nativePlatform } from "../platform";
import { wipeNativeFiles } from "./files";
import { unregisterCurrentPushDevice } from "./push";
import { syncMayBeOn } from "./syncFlag";

/**
 * Sign-out / account-deletion sequence for the device (docs/plans/step-9.md 2.5), called BEFORE
 * the sign-out request so the bearer token can still authorize the push unregister:
 * best-effort push device removal. The token store and image cache are cleared by the caller
 * afterwards (`clearSession`), which also calls `wipeNativeLocalData`.
 */
export async function beforeNativeSignOut(): Promise<void> {
  await unregisterCurrentPushDevice();
  if (nativePlatform() === "ios" && syncMayBeOn()) {
    // Pause this phone's album sync on the server and forget the local setup (best effort, bounded
    // so a stalled call cannot block signing out).
    await Promise.race([
      import("./photoSync").then((m) => m.photoSync.onSignOut()),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ]).catch(() => undefined);
  }
}

/** Deletes working copies of photos (uploads, share downloads) from the device. */
export async function wipeNativeLocalData(): Promise<void> {
  await wipeNativeFiles();
  if (nativePlatform() === "ios" && syncMayBeOn()) {
    // Album-sync config and ledger (no API call: the session may already be gone).
    await import("./photoSync").then((m) => m.photoSync.clearLocal()).catch(() => undefined);
  }
}
