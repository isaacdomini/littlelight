import { wipeNativeFiles } from "./files";
import { unregisterCurrentPushDevice } from "./push";

/**
 * Sign-out / account-deletion sequence for the device (docs/plans/step-9.md 2.5), called BEFORE
 * the sign-out request so the bearer token can still authorize the push unregister:
 * best-effort push device removal. The token store and image cache are cleared by the caller
 * afterwards (`clearSession`), which also calls `wipeNativeLocalData`.
 */
export async function beforeNativeSignOut(): Promise<void> {
  await unregisterCurrentPushDevice();
}

/** Deletes working copies of photos (uploads, share downloads) from the device. */
export async function wipeNativeLocalData(): Promise<void> {
  await wipeNativeFiles();
}
