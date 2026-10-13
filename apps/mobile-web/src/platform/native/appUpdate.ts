import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_STATE_KEY,
  APP_UPDATE_VERSION_RE,
  type AppUpdateEnvelope,
  type AppUpdateManifestResponse,
  appUpdateManifestResponseSchema,
} from "@tinyglow/shared";
import { apiFetch } from "../../lib/api";
import { summarize, uploadManager } from "../../lib/upload/manager";
import { type NativePlatform, nativePlatform } from "../platform";
import {
  type AppUpdateOutcome,
  appUpdateStatus,
  type StageOutcome,
  type UpdaterInfo,
} from "./appUpdateStatus";
import { photoSync } from "./photoSync";

// Live-update client (docs/plans/step-14.md 2.8, D3, D4, D9, D10). Native only and a lazy chunk:
// `bootstrap.ts`, `NativeEvents.tsx`, `push.ts` and Settings -> About import it with `import()`,
// so the web bundle carries no updater code. On the web every entry point is a no-op.
//
// A check: (1) native only; (2) `launch`/`resume` at most every APP_UPDATE_CHECK_INTERVAL_MS
// (`manual` ignores the interval); (3) idle only: no upload item active in any lane and album
// sync not `syncing` (otherwise skipped and retried on the next trigger); (4) `info()` ->
// `GET /api/app-update/manifest?platform&native&current`; (5) an offered envelope goes to the
// native `stage()` unchanged (signature check, D4 network rules, download, verify, stage; applied
// on the next cold launch). Only `{ lastCheckAt }` is stored. Nothing is logged: no body, URL,
// signature or version.

interface TinyglowUpdaterPlugin {
  info(): Promise<UpdaterInfo>;
  stage(
    args: AppUpdateEnvelope,
  ): Promise<{ outcome: StageOutcome; version?: string; bytes?: number }>;
  notifyAppReady(): Promise<void>;
  applyNow(): Promise<void>;
  reset(): Promise<void>;
}

export type CheckTrigger = "launch" | "resume" | "manual";

/** Outcomes after which the next automatic check waits the full interval. */
const SETTLED: ReadonlySet<AppUpdateOutcome> = new Set<AppUpdateOutcome>([
  "staged",
  "already_staged",
  "up_to_date",
  "native_too_old",
  "rejected",
  "verify_failed",
  "disabled",
  "unavailable",
]);

const INFO_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Generous: a full bundle on a slow Wi-Fi. The native side has its own 20 s per-file limit. */
const STAGE_TIMEOUT_MS = 10 * 60_000;

/** Everything a check touches, injectable for tests. */
export interface AppUpdaterDeps {
  platform: () => NativePlatform | null;
  /**
   * Resolves with a wrapper, never with the plugin itself: a Capacitor plugin is a Proxy that
   * answers `then`, so resolving a promise with it hangs (NATIVE.md pitfall 1).
   */
  plugin: () => Promise<{ U: TinyglowUpdaterPlugin }>;
  fetchManifest: (query: string) => Promise<AppUpdateManifestResponse>;
  uploadsActive: () => boolean;
  syncing: () => boolean;
  now: () => number;
  readLastCheckAt: () => number | null;
  writeLastCheckAt: (at: number) => void;
}

/** A native call must never hang a caller: after `ms`, settle with `fallback`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function isInfo(v: unknown): v is UpdaterInfo {
  const i = v as Partial<UpdaterInfo> | null;
  return (
    typeof i === "object" &&
    i !== null &&
    typeof i.nativeVersion === "string" &&
    typeof i.nativeBuild === "number" &&
    Number.isInteger(i.nativeBuild) &&
    typeof i.currentVersion === "string" &&
    (i.currentSource === "builtin" || i.currentSource === "ota")
  );
}

function normalizeInfo(raw: UpdaterInfo): UpdaterInfo {
  return {
    nativeVersion: raw.nativeVersion,
    nativeBuild: raw.nativeBuild,
    builtinVersion: typeof raw.builtinVersion === "string" ? raw.builtinVersion : "",
    currentVersion: raw.currentVersion,
    currentSource: raw.currentSource,
    stagedVersion: typeof raw.stagedVersion === "string" ? raw.stagedVersion : null,
    androidPushConfigured: raw.androidPushConfigured === true,
  };
}

export function createAppUpdater(deps: AppUpdaterDeps) {
  let infoInFlight: Promise<UpdaterInfo | null> | null = null;
  let checkInFlight: Promise<AppUpdateOutcome | "skipped"> | null = null;

  /** Native facts, or `null` on the web / a shell without the updater plugin. Cached per session. */
  function info(opts: { fresh?: boolean } = {}): Promise<UpdaterInfo | null> {
    if (!deps.platform()) return Promise.resolve(null);
    if (opts.fresh || !infoInFlight) {
      infoInFlight = (async () => {
        try {
          const { U } = await deps.plugin();
          const raw = await withTimeout<unknown>(U.info(), INFO_TIMEOUT_MS, null);
          const value = isInfo(raw) ? normalizeInfo(raw) : null;
          appUpdateStatus.set({ info: value, infoLoaded: true });
          return value;
        } catch {
          appUpdateStatus.set({ info: null, infoLoaded: true });
          return null;
        }
      })();
    }
    return infoInFlight;
  }

  /** True while an upload (any lane) or an album sync run is in progress. */
  function busy(): boolean {
    try {
      return deps.uploadsActive() || deps.syncing();
    } catch {
      return true;
    }
  }

  async function run(trigger: CheckTrigger): Promise<AppUpdateOutcome | "skipped"> {
    const platform = deps.platform();
    if (!platform) return "skipped";
    if (trigger !== "manual") {
      const last = deps.readLastCheckAt();
      if (last !== null && deps.now() - last < APP_UPDATE_CHECK_INTERVAL_MS && deps.now() >= last) {
        return "skipped";
      }
    }
    const finish = (outcome: AppUpdateOutcome): AppUpdateOutcome => {
      if (SETTLED.has(outcome)) deps.writeLastCheckAt(deps.now());
      appUpdateStatus.set({ phase: "idle", outcome });
      return outcome;
    };
    if (busy()) {
      // Re-tried on the next trigger; only a manual check reports it.
      if (trigger === "manual") appUpdateStatus.set({ outcome: "busy" });
      return "busy";
    }
    appUpdateStatus.set({ phase: "checking" });
    const shell = await info({ fresh: true });
    if (!shell) {
      appUpdateStatus.set({ phase: "idle" });
      return "skipped";
    }
    const params = new URLSearchParams({ platform, native: String(shell.nativeBuild) });
    if (APP_UPDATE_VERSION_RE.test(shell.currentVersion)) {
      params.set("current", shell.currentVersion);
    }
    let res: AppUpdateManifestResponse | null;
    try {
      res = await withTimeout<AppUpdateManifestResponse | null>(
        deps.fetchManifest(params.toString()),
        FETCH_TIMEOUT_MS,
        null,
      );
    } catch {
      res = null;
    }
    if (!res) return finish("error");
    if (!res.update) return finish(res.reason ?? "unavailable");
    // Uploads may have started while we asked the server: stay out of their way.
    if (busy()) {
      appUpdateStatus.set({ phase: "idle", ...(trigger === "manual" ? { outcome: "busy" } : {}) });
      return "busy";
    }
    appUpdateStatus.set({ phase: "downloading" });
    let outcome: AppUpdateOutcome = "error";
    try {
      const { U } = await deps.plugin();
      const { manifestJson, signature, keyId } = res.update;
      const staged = await withTimeout<{ outcome?: unknown } | null>(
        U.stage({ manifestJson, signature, keyId }),
        STAGE_TIMEOUT_MS,
        null,
      );
      outcome = isStageOutcome(staged?.outcome) ? staged.outcome : "error";
    } catch {
      outcome = "error";
    }
    if (outcome === "staged" || outcome === "already_staged" || outcome === "up_to_date") {
      await info({ fresh: true });
    }
    return finish(outcome);
  }

  return {
    info,
    busy,

    /** Fire-and-forget safe: never throws, single-flight. */
    checkForUpdate(trigger: CheckTrigger): Promise<AppUpdateOutcome | "skipped"> {
      if (!checkInFlight) {
        checkInFlight = run(trigger)
          .catch((): AppUpdateOutcome => {
            appUpdateStatus.set({ phase: "idle", outcome: "error" });
            return "error";
          })
          .finally(() => {
            checkInFlight = null;
          });
      }
      return checkInFlight;
    },

    /** Every launch, after the first render: cancels the native rollback watchdog. Never throws. */
    async notifyAppReady(): Promise<void> {
      if (!deps.platform()) return;
      try {
        const { U } = await deps.plugin();
        await withTimeout(U.notifyAppReady(), INFO_TIMEOUT_MS, undefined);
      } catch {
        // older shell without the updater: nothing to confirm
      }
    },

    /** Restart into the staged bundle. Refuses (`busy`) while an upload or sync runs. */
    async applyNow(): Promise<"applied" | "busy" | "none" | "failed"> {
      if (!deps.platform()) return "none";
      if (busy()) return "busy";
      const current = await info({ fresh: true });
      if (!current?.stagedVersion) return "none";
      try {
        const { U } = await deps.plugin();
        await U.applyNow();
        return "applied";
      } catch {
        return "failed";
      }
    },

    /** Back to the web bundled with the app (clears every downloaded bundle; the app reloads). */
    async reset(): Promise<boolean> {
      if (!deps.platform()) return false;
      try {
        const { U } = await deps.plugin();
        await U.reset();
        deps.writeLastCheckAt(0);
        await info({ fresh: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

const STAGE_OUTCOMES: ReadonlySet<string> = new Set<StageOutcome>([
  "staged",
  "up_to_date",
  "already_staged",
  "native_too_old",
  "wifi_required",
  "constrained",
  "no_space",
  "network",
  "verify_failed",
  "rejected",
]);

function isStageOutcome(v: unknown): v is StageOutcome {
  return typeof v === "string" && STAGE_OUTCOMES.has(v);
}

// --- default wiring ---------------------------------------------------------------------------

let pluginInstance: TinyglowUpdaterPlugin | null = null;

function readLastCheckAt(): number | null {
  try {
    const raw = window.localStorage.getItem(APP_UPDATE_STATE_KEY);
    if (!raw) return null;
    const at = (JSON.parse(raw) as { lastCheckAt?: unknown }).lastCheckAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function writeLastCheckAt(at: number): void {
  try {
    window.localStorage.setItem(APP_UPDATE_STATE_KEY, JSON.stringify({ lastCheckAt: at }));
  } catch {
    // storage unavailable: the next trigger checks again (cheap, cached server-side)
  }
}

export const appUpdater = createAppUpdater({
  platform: nativePlatform,
  async plugin() {
    if (!pluginInstance) {
      const { registerPlugin } = await import("@capacitor/core");
      pluginInstance = registerPlugin<TinyglowUpdaterPlugin>("TinyglowUpdater");
    }
    return { U: pluginInstance };
  },
  fetchManifest: (query) =>
    apiFetch(`/app-update/manifest?${query}`, { schema: appUpdateManifestResponseSchema }),
  uploadsActive: () => summarize(uploadManager.getSnapshot()).active > 0,
  syncing: () => nativePlatform() === "ios" && photoSync.getStatus?.().phase === "syncing",
  now: () => Date.now(),
  readLastCheckAt,
  writeLastCheckAt,
});

export const checkForUpdate = (trigger: CheckTrigger) => appUpdater.checkForUpdate(trigger);
export const notifyAppReady = () => appUpdater.notifyAppReady();
export const updaterInfo = (opts?: { fresh?: boolean }) => appUpdater.info(opts);
