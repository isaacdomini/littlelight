import type { PluginListenerHandle } from "@capacitor/core";
import {
  type ImportSource,
  type ImportSourceError,
  importSourceResponseSchema,
  importSourcesListResponseSchema,
  meResponseSchema,
  SYNC_BACKGROUND_BATCH,
  SYNC_CONFIG_KEY,
  SYNC_FOREGROUND_BATCH,
  SYNC_MIN_INTERVAL_SEC,
  type SyncTrigger,
} from "@tinyglow/shared";
import { useEffect, useSyncExternalStore } from "react";
import { apiFetch, isApiError } from "../../lib/api";
import { type ItemState, uploadManager } from "../../lib/upload/manager";
import { getTokenStore } from "../tokenStore";
import type { NativeFileRef } from "../uploader";
import { getInstallId } from "./installId";
import { type SecureKv, secureKv } from "./secureKv";
import { setSyncFlag, syncMayBeOn } from "./syncFlag";

// Apple Photos album sync (docs/plans/step-10.md 2.5, D1-D4, D12, D13). iOS, admins only.
// Feeds the existing UploadManager on its low-priority "sync" lane (at most 2 uploads at once),
// newest photos first, in small batches. Nothing is ever deleted from Tinyglow or from the
// phone. PHAsset identifiers, album ids, file names and paths stay in JS memory and in the native
// ledger: they are never logged, never sent to the API (only the album *title*, which the parent
// sees in Settings, and counters) and never reach telemetry.
//
// Layout:
// - the native ledger (Application Support/ll-sync) remembers which assets are done;
// - the config below (Keychain, `ll.sync.v1`) remembers which album/baby is synced;
// - the server row (`import_sources`) holds the parent-visible status and counters.

export type AuthStatus = "notDetermined" | "restricted" | "denied" | "authorized" | "limited";
export type ThermalState = "nominal" | "fair" | "serious" | "critical";
type AssetOutcome = "done" | "duplicate" | "failed" | "skipped";

export interface PhotoSyncPlugin {
  authorizationStatus(): Promise<{ status: AuthStatus }>;
  requestAuthorization(): Promise<{ status: AuthStatus }>;
  listAlbums(): Promise<{ albums: { id: string; title: string; count: number }[] }>;
  listPendingAssets(o: { albumId: string; limit: number }): Promise<{
    assets: { id: string; createdAt: string | null }[];
    remaining: number;
    albumExists: boolean;
  }>;
  exportAssets(o: { ids: string[] }): Promise<{
    files: {
      id: string;
      path: string;
      name: string;
      mime: string;
      size: number;
      sha256: string;
      takenAt: string | null;
    }[];
    failed: { id: string; reason: "unavailable" | "icloud" | "write" | "unsupported" }[];
  }>;
  discardFiles?(o: { paths: string[] }): Promise<unknown>;
  recordOutcomes(o: {
    albumId: string;
    outcomes: { id: string; outcome: AssetOutcome }[];
  }): Promise<unknown>;
  ledgerSummary(o: { albumId: string }): Promise<{
    done: number;
    duplicate: number;
    failed: number;
    skipped: number;
  }>;
  resetLedger(o?: { albumId?: string }): Promise<unknown>;
  conditions(): Promise<{
    wifi: boolean;
    expensive: boolean;
    lowPowerMode: boolean;
    thermalState: ThermalState;
  }>;
  scheduleBackgroundRefresh(): Promise<unknown>;
  completeBackgroundTask(o: { taskId: string; success: boolean }): Promise<unknown>;
  addListener(
    event: "backgroundSync" | "backgroundSyncExpired",
    cb: (e: { taskId: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export interface SyncConfig {
  sourceId: string;
  babyId: string;
  /** PhotoKit `localIdentifier`. Stays on this device. */
  albumId: string;
  albumTitle: string;
  wifiOnly: boolean;
  paused: boolean;
}

/**
 * - `off`: not set up. `idle`: set up, nothing running. `syncing`: a run is in progress.
 * - `waiting_wifi` / `low_power`: the run was skipped because of conditions, it retries on the next
 *   trigger. `paused`: the parent paused it. `error`: see `lastError`.
 */
export type SyncPhase =
  | "off"
  | "idle"
  | "syncing"
  | "waiting_wifi"
  | "low_power"
  | "paused"
  | "error";

export interface SyncStatus {
  /** False until the stored config has been read. */
  loaded: boolean;
  config: SyncConfig | null;
  phase: SyncPhase;
  /** Assets handled in the current run / assets known to be waiting (this run). */
  progress: { done: number; total: number } | null;
  lastError: ImportSourceError | null;
  /** Epoch ms of the last run that got past the gates in this session. */
  lastRunAt: number | null;
  /** `removed`: the server turned this phone's sync off (demoted, removed, row deleted). */
  notice: "removed" | null;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: "permission" | "exists" | "limit" | "forbidden" | "trashed" | "network" };

export interface PhotoSyncDeps {
  plugin: () => PhotoSyncPlugin;
  kv: SecureKv;
  api: typeof apiFetch;
  uploads: Pick<
    typeof uploadManager,
    | "addNative"
    | "waitForTerminal"
    | "errorOf"
    | "clearFinished"
    | "cancel"
    | "subscribe"
    | "getSnapshot"
  >;
  now: () => number;
  /** True when a user session exists (the Keychain token store has tokens). */
  hasSession: () => Promise<boolean>;
  installId: () => Promise<string>;
  deviceLabel: () => string;
  /**
   * Is this phone's source row still there and is the user still an admin of the baby?
   * `unknown` (offline, endpoint missing) lets the run continue.
   */
  checkSource: (cfg: SyncConfig) => Promise<"ok" | "gone" | "unknown">;
}

const COOLDOWN_FREE_LIMIT_MS = 6 * 3_600_000;
const MAX_BATCHES_PER_RUN = 200;
const HOT: ReadonlySet<ThermalState> = new Set(["serious", "critical"]);
/** Upload errors that mean "this photo can't be imported", not "try again". */
const UNSUPPORTED_CODES = new Set([
  "unsupported",
  "too_large",
  "unsupported_media_type",
  "file_too_large",
  "decode_failed",
]);

function isConfig(v: unknown): v is SyncConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.sourceId === "string" &&
    typeof c.babyId === "string" &&
    typeof c.albumId === "string" &&
    typeof c.albumTitle === "string" &&
    typeof c.wifiOnly === "boolean" &&
    typeof c.paused === "boolean"
  );
}

export class PhotoSyncManager {
  private status: SyncStatus = {
    loaded: false,
    config: null,
    phase: "off",
    progress: null,
    lastError: null,
    lastRunAt: null,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private initialized = false;
  private expiredTask: string | null = null;
  private waitAbort: AbortController | null = null;

  constructor(private readonly deps: PhotoSyncDeps) {}

  // ---- store -----------------------------------------------------------------------------

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getStatus = (): SyncStatus => this.status;

  private set(change: Partial<SyncStatus>) {
    this.status = { ...this.status, ...change };
    for (const l of this.listeners) l();
  }

  private setConfig(config: SyncConfig | null) {
    this.set({
      config,
      ...(config === null ? { phase: "off", progress: null, lastError: null } : {}),
    });
  }

  /** Reads the stored config once. Safe to call repeatedly. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      let config: SyncConfig | null = null;
      try {
        const raw = await this.deps.kv.get(SYNC_CONFIG_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (isConfig(parsed)) config = parsed;
      } catch {
        // corrupt entry: treated as not set up
      }
      this.set({
        loaded: true,
        config,
        phase: config ? (config.paused ? "paused" : "idle") : "off",
      });
    })();
    return this.loading;
  }

  private async saveConfig(config: SyncConfig | null) {
    this.setConfig(config);
    setSyncFlag(config !== null);
    try {
      if (config) await this.deps.kv.set(SYNC_CONFIG_KEY, JSON.stringify(config));
      else await this.deps.kv.remove(SYNC_CONFIG_KEY);
    } catch {
      // Keychain unavailable: the config lives for this launch only
    }
  }

  // ---- native listeners ------------------------------------------------------------------

  /** Registers the background-refresh listeners. Idempotent; never throws. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const p = this.deps.plugin();
      await p.addListener(
        "backgroundSync",
        (e) => void this.runSync("background", { taskId: e.taskId }),
      );
      await p.addListener("backgroundSyncExpired", (e) => {
        this.expiredTask = e.taskId;
        this.waitAbort?.abort();
      });
    } catch {
      this.initialized = false;
    }
  }

  // ---- reads for the UI ------------------------------------------------------------------

  async authorization(): Promise<AuthStatus> {
    try {
      return (await this.deps.plugin().authorizationStatus()).status;
    } catch {
      return "denied";
    }
  }

  /** Shows the system Photos prompt (first time only; later it just reports the status). */
  async requestAuthorization(): Promise<AuthStatus> {
    try {
      const p = this.deps.plugin();
      const now = (await p.authorizationStatus()).status;
      if (now !== "notDetermined") return now;
      return (await p.requestAuthorization()).status;
    } catch {
      return "denied";
    }
  }

  async albums(): Promise<{ id: string; title: string; count: number }[]> {
    try {
      return (await this.deps.plugin().listAlbums()).albums;
    } catch {
      return [];
    }
  }

  // ---- settings actions ------------------------------------------------------------------

  /**
   * Turns sync on for one album and baby (admins only; the server enforces it). The Photos
   * prompt appears here and in the setup sheet's "Allow access" step, nowhere else.
   */
  async enable(o: {
    babyId: string;
    albumId: string;
    albumTitle: string;
    wifiOnly: boolean;
  }): Promise<EnableResult> {
    await this.load();
    if ((await this.requestAuthorization()) !== "authorized") {
      return { ok: false, reason: "permission" };
    }
    const prev = this.status.config;
    let source: ImportSource;
    try {
      source = (
        await this.deps.api(`/babies/${o.babyId}/import-sources`, {
          method: "POST",
          body: {
            kind: "apple_photos",
            deviceId: await this.deps.installId(),
            deviceLabel: this.deps.deviceLabel(),
            albumTitle: o.albumTitle.slice(0, 120),
            wifiOnly: o.wifiOnly,
          },
          schema: importSourceResponseSchema,
        })
      ).source;
    } catch (e) {
      if (isApiError(e)) {
        if (e.code === "import_source_exists") return { ok: false, reason: "exists" };
        if (e.code === "import_source_limit") return { ok: false, reason: "limit" };
        if (e.code === "baby_trashed") return { ok: false, reason: "trashed" };
        if (e.status === 403 || e.status === 404) return { ok: false, reason: "forbidden" };
      }
      return { ok: false, reason: "network" };
    }
    // Moving to another album or baby: forget the old one (the old ledger would never be used).
    if (prev && (prev.albumId !== o.albumId || prev.babyId !== o.babyId)) {
      await this.deps
        .plugin()
        .resetLedger({ albumId: prev.albumId })
        .catch(() => undefined);
      if (prev.babyId !== o.babyId) {
        await this.deps
          .api(`/import-sources/${prev.sourceId}`, { method: "DELETE" })
          .catch(() => undefined);
      }
    }
    await this.saveConfig({
      sourceId: source.id,
      babyId: o.babyId,
      albumId: o.albumId,
      albumTitle: o.albumTitle,
      wifiOnly: o.wifiOnly,
      paused: false,
    });
    this.set({ phase: "idle", lastError: null, notice: null });
    void this.init();
    void this.runSync("manual");
    return { ok: true };
  }

  async setPaused(paused: boolean): Promise<void> {
    const cfg = this.status.config;
    if (!cfg) return;
    await this.patch(cfg, { paused, ...(paused ? {} : { lastError: null }) });
    await this.saveConfig({ ...cfg, paused });
    this.set({ phase: paused ? "paused" : "idle", ...(paused ? {} : { lastError: null }) });
    if (!paused) void this.runSync("manual");
  }

  async setWifiOnly(wifiOnly: boolean): Promise<void> {
    const cfg = this.status.config;
    if (!cfg) return;
    await this.patch(cfg, { wifiOnly });
    await this.saveConfig({ ...cfg, wifiOnly });
  }

  /** Stops syncing. Removes the sync setup and this device's ledger; photos stay in Tinyglow. */
  async disable(): Promise<void> {
    const cfg = this.status.config;
    if (!cfg) return;
    this.waitAbort?.abort();
    await this.deps
      .api(`/import-sources/${cfg.sourceId}`, { method: "DELETE" })
      .catch(() => undefined);
    await this.deps
      .plugin()
      .resetLedger({ albumId: cfg.albumId })
      .catch(() => undefined);
    await this.saveConfig(null);
  }

  /** Before sign-out (the bearer token is still valid): pause the server row, forget everything. */
  async onSignOut(): Promise<void> {
    await this.load();
    const cfg = this.status.config;
    if (!cfg) return;
    this.waitAbort?.abort();
    // Wipe locally first so a stalled network call cannot leave the ledger/config behind.
    await this.clearLocal();
    await this.patch(cfg, { paused: true, lastError: "signed_out" });
  }

  /** Local-only wipe (account deletion, session lost): ledger and config, no API call. */
  async clearLocal(): Promise<void> {
    this.waitAbort?.abort();
    await this.deps
      .plugin()
      .resetLedger()
      .catch(() => undefined);
    await this.saveConfig(null);
  }

  // ---- server row ------------------------------------------------------------------------

  /** Best-effort PATCH. A 404 means the server row is gone: the sync is switched off locally. */
  private async patch(cfg: SyncConfig, body: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.api(`/import-sources/${cfg.sourceId}`, { method: "PATCH", body });
    } catch (e) {
      if (isApiError(e) && e.status === 404 && this.status.config?.sourceId === cfg.sourceId) {
        await this.turnedOff();
      }
    }
  }

  /** The server removed this phone's sync: stop, forget the setup, keep the ledger, tell the user. */
  private async turnedOff() {
    this.waitAbort?.abort();
    await this.saveConfig(null);
    this.set({ notice: "removed" });
  }

  // ---- running ---------------------------------------------------------------------------

  /**
   * Runs a sync (single-flight). Launch/resume/background runs within `SYNC_MIN_INTERVAL_SEC` of
   * the last run do nothing; "manual" always runs. Never throws.
   */
  runSync(trigger: SyncTrigger, opts: { taskId?: string } = {}): Promise<void> {
    if (this.flight) {
      const running = this.flight;
      // A background task must still be completed, whichever run does the work.
      return opts.taskId
        ? running.then(() => this.finishTask(opts.taskId as string, true))
        : running;
    }
    const p = this.run(trigger, opts.taskId).finally(() => {
      if (this.flight === p) this.flight = null;
    });
    this.flight = p;
    return p;
  }

  private async finishTask(taskId: string, success: boolean) {
    try {
      await this.deps.plugin().completeBackgroundTask({ taskId, success });
    } catch {
      // the OS expires the task on its own
    }
  }

  private async run(trigger: SyncTrigger, taskId: string | undefined): Promise<void> {
    let success = true;
    try {
      await this.load();
      const cfg = this.status.config;
      if (!cfg) return;
      success = await this.execute(cfg, trigger, taskId);
      await this.deps
        .plugin()
        .scheduleBackgroundRefresh()
        .catch(() => undefined);
    } catch {
      success = false;
      if (this.status.phase === "syncing") this.set({ phase: "idle", progress: null });
    } finally {
      this.waitAbort = null;
      if (taskId) await this.finishTask(taskId, success);
    }
  }

  private expired = (taskId: string | undefined) =>
    taskId !== undefined && this.expiredTask === taskId;

  /** Why a run must not start (or continue) right now; `null` = go. */
  private async gate(cfg: SyncConfig): Promise<SyncPhase | null> {
    const c = await this.deps.plugin().conditions();
    if (c.lowPowerMode || HOT.has(c.thermalState)) return "low_power";
    if (cfg.wifiOnly && !c.wifi) return "waiting_wifi";
    return null;
  }

  /** Returns whether the run ended without a failure the OS should know about. */
  private async execute(
    start: SyncConfig,
    trigger: SyncTrigger,
    taskId: string | undefined,
  ): Promise<boolean> {
    const { plugin, now } = this.deps;
    let cfg = start;
    const s = this.status;
    if (!(await this.deps.hasSession())) return true;
    if ((await this.deps.checkSource(cfg)) === "gone") {
      await this.turnedOff();
      return true;
    }
    if (trigger !== "manual") {
      if (s.lastRunAt !== null && now() - s.lastRunAt < SYNC_MIN_INTERVAL_SEC * 1000) return true;
      if (
        (s.lastError === "free_tier_limit" || s.lastError === "pending_limit") &&
        s.lastRunAt !== null &&
        now() - s.lastRunAt < COOLDOWN_FREE_LIMIT_MS
      ) {
        return true;
      }
    }
    if (cfg.paused) {
      this.set({ phase: s.lastError ? "error" : "paused" });
      return true;
    }
    if ((await plugin().authorizationStatus()).status !== "authorized") {
      await this.stopWith(cfg, "permission_denied", true);
      return true;
    }
    const blocked = await this.gate(cfg);
    if (blocked) {
      this.set({ phase: blocked, progress: null });
      return true;
    }

    this.set({
      phase: "syncing",
      lastError: null,
      progress: { done: 0, total: 0 },
      lastRunAt: now(),
    });
    this.expiredTask = null;
    const limit = trigger === "background" ? SYNC_BACKGROUND_BATCH : SYNC_FOREGROUND_BATCH;
    let processed = 0;
    let ended: ImportSourceError | null = null;
    let hadError = s.lastError !== null;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      if (this.expired(taskId) || !this.status.config) break;
      cfg = this.status.config;
      if (cfg.paused) break;
      if (batch > 0) {
        const again = await this.gate(cfg);
        if (again) {
          this.set({ phase: again });
          return true;
        }
      }
      const list = await plugin().listPendingAssets({ albumId: cfg.albumId, limit });
      if (!list.albumExists) {
        await this.stopWith(cfg, "album_missing", true);
        return true;
      }
      if (list.assets.length === 0) break;
      this.set({
        progress: { done: processed, total: processed + list.assets.length + list.remaining },
      });
      const r = await this.processBatch(
        cfg,
        list.assets.map((a) => a.id),
        processed,
        list.assets.length + list.remaining,
        trigger,
        hadError,
      );
      processed += r.handled;
      hadError = false;
      if (r.stop) {
        ended = r.stop;
        break;
      }
      if (trigger === "background") break;
    }

    if (!this.status.config) return true;
    this.set({
      phase: ended ? "error" : this.status.config.paused ? "paused" : "idle",
      progress: null,
      lastError: ended,
    });
    return true;
  }

  private async stopWith(cfg: SyncConfig, error: ImportSourceError, pause: boolean) {
    await this.patch(cfg, { lastError: error, ...(pause ? { paused: true } : {}) });
    if (this.status.config) {
      await this.saveConfig({ ...this.status.config, paused: pause || this.status.config.paused });
    }
    this.set({ phase: "error", lastError: error, progress: null });
  }

  /** One batch: export, upload on the sync lane, wait, record in the ledger, report to the server. */
  private async processBatch(
    cfg: SyncConfig,
    ids: string[],
    before: number,
    total: number,
    trigger: SyncTrigger,
    clearsError: boolean,
  ): Promise<{ handled: number; stop: ImportSourceError | null }> {
    const { plugin, uploads } = this.deps;
    const outcomes: { id: string; outcome: AssetOutcome }[] = [];
    const exported = await plugin().exportAssets({ ids });
    for (const f of exported.failed) {
      outcomes.push({ id: f.id, outcome: f.reason === "unsupported" ? "skipped" : "failed" });
    }
    const files = exported.files;
    const refs: NativeFileRef[] = files.map((f) => ({
      path: f.path,
      name: f.name,
      mime: f.mime,
      size: f.size,
      sha256: f.sha256.toLowerCase(),
      ...(f.takenAt ? { takenAt: f.takenAt } : {}),
    }));
    const clientIds =
      refs.length > 0
        ? uploads.addNative(cfg.babyId, refs, undefined, { lane: "sync", wifiOnly: cfg.wifiOnly })
        : [];

    const abort = new AbortController();
    this.waitAbort = abort;
    const offProgress = uploads.subscribe(() => {
      const mine = new Set(clientIds);
      let done = outcomes.length;
      for (const i of uploads.getSnapshot()) {
        if (mine.has(i.clientId) && isSettled(i.state)) done++;
      }
      this.set({
        progress: { done: Math.min(total, before + done), total: Math.max(total, before + done) },
      });
    });
    let states: Map<string, ItemState>;
    try {
      states = await uploads.waitForTerminal(clientIds, abort.signal);
    } finally {
      offProgress();
    }

    let stop = null as ImportSourceError | null;
    let networkFails = 0;
    const deferred: { id: string; outcome: AssetOutcome }[] = [];
    for (const [i, f] of files.entries()) {
      const cid = clientIds[i] as string;
      const state = states.get(cid);
      if (state === "ingested" || state === "completed")
        outcomes.push({ id: f.id, outcome: "done" });
      else if (state === "duplicate") outcomes.push({ id: f.id, outcome: "duplicate" });
      else if (state === "failed") {
        const code = uploads.errorOf(cid);
        if (code === "free_tier_limit") {
          // Leave it pending (no attempt used): a later run after an upgrade retries it.
          stop = "free_tier_limit";
        } else if (code === "pending_limit") {
          // Guest's pending queue is full: leave it pending, no attempt used; retry after approvals.
          stop ??= "pending_limit";
        } else if (code && UNSUPPORTED_CODES.has(code)) {
          outcomes.push({ id: f.id, outcome: "skipped" });
        } else {
          if (code === "network") networkFails++;
          deferred.push({ id: f.id, outcome: "failed" });
        }
      } else {
        // Still in flight (the background task expired, or sync was switched off): drop it.
        uploads.cancel(cid);
      }
    }
    if (!stop && files.length > 0 && networkFails === files.length) {
      // Nothing got through: offline or the server is down. Don't burn attempts.
      stop = "network";
    } else {
      outcomes.push(...deferred);
    }

    // Anything exported but not uploaded is cleaned up natively (copies of uploaded files are
    // already released by the upload manager).
    void plugin()
      .discardFiles?.({ paths: refs.map((r) => r.path) })
      ?.catch(() => undefined);
    uploads.clearFinished(cfg.babyId, "sync");

    if (outcomes.length > 0) await plugin().recordOutcomes({ albumId: cfg.albumId, outcomes });
    const count = (o: AssetOutcome) => outcomes.filter((x) => x.outcome === o).length;
    await this.patch(cfg, {
      lastSyncAt: new Date(this.deps.now()).toISOString(),
      lastTrigger: trigger,
      importedDelta: count("done"),
      duplicateDelta: count("duplicate"),
      failedDelta: count("failed"),
      skippedDelta: count("skipped"),
      ...(stop ? { lastError: stop } : clearsError ? { lastError: null } : {}),
    });
    return { handled: outcomes.length, stop };
  }
}

function isSettled(s: ItemState): boolean {
  return (
    s === "ingested" || s === "completed" || s === "duplicate" || s === "failed" || s === "aborted"
  );
}

let pluginProxy: PhotoSyncPlugin | null = null;

/**
 * Calls the native plugin. `@capacitor/core` loads lazily, and the plugin proxy is only ever used
 * inside `fn`, never returned or resolved from a promise (NATIVE.md, Pitfalls #1).
 */
async function call<R>(fn: (p: PhotoSyncPlugin) => Promise<R>): Promise<R> {
  const { registerPlugin } = await import("@capacitor/core");
  pluginProxy ??= registerPlugin<PhotoSyncPlugin>("TinyglowPhotoSync");
  return fn(pluginProxy);
}

const nativePluginFacade: PhotoSyncPlugin = {
  authorizationStatus: () => call((p) => p.authorizationStatus()),
  requestAuthorization: () => call((p) => p.requestAuthorization()),
  listAlbums: () => call((p) => p.listAlbums()),
  listPendingAssets: (o) => call((p) => p.listPendingAssets(o)),
  exportAssets: (o) => call((p) => p.exportAssets(o)),
  discardFiles: (o) => call((p) => p.discardFiles?.(o) ?? Promise.resolve()),
  recordOutcomes: (o) => call((p) => p.recordOutcomes(o)),
  ledgerSummary: (o) => call((p) => p.ledgerSummary(o)),
  resetLedger: (o) => call((p) => p.resetLedger(o)),
  conditions: () => call((p) => p.conditions()),
  scheduleBackgroundRefresh: () => call((p) => p.scheduleBackgroundRefresh()),
  completeBackgroundTask: (o) => call((p) => p.completeBackgroundTask(o)),
  addListener: (event, cb) => call((p) => p.addListener(event, cb)),
};

export function createPhotoSyncManager(over: Partial<PhotoSyncDeps> = {}): PhotoSyncManager {
  return new PhotoSyncManager({
    plugin: () => nativePluginFacade,
    // No marker: sync was never turned on here, so skip the Keychain read.
    kv: { ...secureKv, get: (k) => (syncMayBeOn() ? secureKv.get(k) : Promise.resolve(null)) },
    api: apiFetch,
    uploads: uploadManager,
    now: () => Date.now(),
    hasSession: async () => (await getTokenStore().get()) !== null,
    installId: () => getInstallId(),
    checkSource: checkSourceOnServer,
    deviceLabel: () => (/iPad/.test(navigator.userAgent) ? "iPad" : "iPhone"),
    ...over,
  });
}

async function checkSourceOnServer(cfg: SyncConfig): Promise<"ok" | "gone" | "unknown"> {
  try {
    const me = await apiFetch("/me", { schema: meResponseSchema });
    const baby = me.babies.find((b) => b.id === cfg.babyId);
    if (baby?.role !== "admin") return "gone";
    const deviceId = await getInstallId();
    const res = await apiFetch(`/me/import-sources?babyId=${cfg.babyId}&deviceId=${deviceId}`, {
      schema: importSourcesListResponseSchema,
    });
    return res.sources.some((x) => x.id === cfg.sourceId) ? "ok" : "gone";
  } catch (e) {
    return isApiError(e) && e.status === 404 ? "gone" : "unknown";
  }
}

export const photoSync = createPhotoSyncManager();

/** Live status for the sync card; loads the stored config on first use. */
export function useSyncStatus(manager: PhotoSyncManager = photoSync): SyncStatus {
  useEffect(() => {
    void manager.load();
  }, [manager]);
  return useSyncExternalStore(manager.subscribe, manager.getStatus);
}
