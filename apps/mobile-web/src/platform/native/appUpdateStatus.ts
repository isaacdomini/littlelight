import webBuild from "../../../app-update.json";

// Live-update status shared by the lazy updater client (`appUpdate.ts`, native only) and
// Settings -> About (docs/plans/step-14.md 2.8). This module holds plain types and a tiny external
// store, no Capacitor code and no plugin name, so it can sit in the web bundle. Nothing here is
// persisted or logged: no manifest, URL or signature ever reaches it.

/** The human label of this web build (`apps/mobile-web/app-update.json`, compiled in). */
export const WEB_VERSION: string =
  typeof webBuild.webVersion === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(webBuild.webVersion)
    ? webBuild.webVersion
    : "web";

/** Shell + bundle facts reported by the native updater (`info()`). */
export interface UpdaterInfo {
  nativeVersion: string;
  nativeBuild: number;
  builtinVersion: string;
  currentVersion: string;
  currentSource: "builtin" | "ota";
  stagedVersion: string | null;
  androidPushConfigured: boolean;
}

/** What the native `stage()` reports. */
export type StageOutcome =
  | "staged"
  | "up_to_date"
  | "already_staged"
  | "native_too_old"
  | "wifi_required"
  | "constrained"
  | "no_space"
  | "network"
  | "verify_failed"
  | "rejected";

/**
 * The last check's result as the About page shows it: a `stage()` outcome, the server's reason
 * when no update is offered (`disabled`, `unavailable`), `busy` (an upload or album sync was
 * running, so nothing was downloaded) or `error` (the check itself failed: offline, timeout).
 */
export type AppUpdateOutcome = StageOutcome | "disabled" | "unavailable" | "busy" | "error";

export interface AppUpdateStatus {
  /** `null` until read, or when this shell has no updater (web, older app build). */
  info: UpdaterInfo | null;
  infoLoaded: boolean;
  /** `checking`: asking the server; `downloading`: the native side is staging a bundle. */
  phase: "idle" | "checking" | "downloading";
  /** Result of the last check in this session (any trigger). */
  outcome: AppUpdateOutcome | null;
}

let status: AppUpdateStatus = { info: null, infoLoaded: false, phase: "idle", outcome: null };
const listeners = new Set<() => void>();

export const appUpdateStatus = {
  get: (): AppUpdateStatus => status,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  set(patch: Partial<AppUpdateStatus>): void {
    status = { ...status, ...patch };
    for (const l of listeners) l();
  },
  /** Tests only. */
  reset(): void {
    status = { info: null, infoLoaded: false, phase: "idle", outcome: null };
    for (const l of listeners) l();
  },
};
