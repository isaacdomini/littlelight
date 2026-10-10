import { SYNC_BACKGROUND_BATCH, SYNC_CONFIG_KEY, SYNC_FOREGROUND_BATCH } from "@littlelight/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  type PhotoSyncDeps,
  PhotoSyncManager,
  type PhotoSyncPlugin,
  type SyncConfig,
} from "./photoSync";
import type { SecureKv } from "./secureKv";

// Apple album sync (docs/plans/step-10.md 2.5, D1-D4, D13): permission only in enable(), Wi-Fi
// and power gates, newest-first small batches, outcomes -> ledger -> counters, free-tier stop,
// network failures not burning attempts, single flight, background task completion, server-side
// removal, sign-out. Every dependency is a fake; no PHAsset id or path may reach the API.

const SOURCE = "11111111-1111-4111-8111-111111111111";
const BABY = "22222222-2222-4222-8222-222222222222";
const BABY2 = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const ALBUM = "ALBUM-LOCAL-ID/L0/040";
const CFG: SyncConfig = {
  sourceId: SOURCE,
  babyId: BABY,
  albumId: ALBUM,
  albumTitle: "Maya",
  wifiOnly: true,
  paused: false,
};

const asset = (n: number) => ({ id: `ASSET-${n}/L0/001`, createdAt: "2026-03-01T10:00:00Z" });
const file = (n: number, over: Record<string, unknown> = {}) => ({
  id: `ASSET-${n}/L0/001`,
  path: `/private/var/Caches/ll-uploads/f${n}.heic`,
  name: `IMG_${n}.HEIC`,
  mime: "image/heic",
  size: 1000 + n,
  sha256: "AB".repeat(32),
  takenAt: "2026-03-01T10:00:00Z",
  ...over,
});

function memKv(initial?: SyncConfig | string): SecureKv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined)
    data.set(SYNC_CONFIG_KEY, typeof initial === "string" ? initial : JSON.stringify(initial));
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

interface Harness {
  m: PhotoSyncManager;
  plugin: { [K in keyof PhotoSyncPlugin]: ReturnType<typeof vi.fn> };
  api: ReturnType<typeof vi.fn>;
  uploads: Record<string, ReturnType<typeof vi.fn>>;
  kv: ReturnType<typeof memKv>;
  clock: { t: number };
  listeners: Map<string, (e: { taskId: string }) => void>;
  states: Map<string, string>;
  errors: Map<string, string>;
  deps: PhotoSyncDeps;
}

function make(
  o: {
    cfg?: SyncConfig | string | null;
    wifi?: boolean;
    lowPower?: boolean;
    thermal?: string;
    auth?: string;
    session?: boolean;
    checkSource?: "ok" | "gone" | "unknown";
    pending?: ReturnType<typeof asset>[][];
    files?: ReturnType<typeof file>[];
    failedExport?: { id: string; reason: string }[];
  } = {},
): Harness {
  const kv = memKv(o.cfg === null ? undefined : (o.cfg ?? CFG));
  const clock = { t: 1_800_000_000_000 };
  const listeners = new Map<string, (e: { taskId: string }) => void>();
  const states = new Map<string, string>();
  const errors = new Map<string, string>();
  const pending = [...(o.pending ?? [[asset(1), asset(2)], []])];
  let n = 0;
  const plugin = {
    authorizationStatus: vi.fn(async () => ({ status: o.auth ?? "authorized" })),
    requestAuthorization: vi.fn(async () => ({ status: "authorized" })),
    listAlbums: vi.fn(async () => ({ albums: [{ id: ALBUM, title: "Maya", count: 3 }] })),
    listPendingAssets: vi.fn(async () => ({
      assets: pending.shift() ?? [],
      remaining: 0,
      albumExists: true,
    })),
    exportAssets: vi.fn(async ({ ids }: { ids: string[] }) => ({
      files: (o.files ?? ids.map((id) => file(Number(/ASSET-(\d+)/.exec(id)?.[1])))).filter((f) =>
        ids.includes(f.id),
      ),
      failed: o.failedExport ?? [],
    })),
    discardFiles: vi.fn(async () => undefined),
    recordOutcomes: vi.fn(async () => undefined),
    ledgerSummary: vi.fn(async () => ({ done: 0, duplicate: 0, failed: 0, skipped: 0 })),
    resetLedger: vi.fn(async () => undefined),
    conditions: vi.fn(async () => ({
      wifi: o.wifi ?? true,
      expensive: !(o.wifi ?? true),
      lowPowerMode: o.lowPower ?? false,
      thermalState: o.thermal ?? "nominal",
    })),
    scheduleBackgroundRefresh: vi.fn(async () => undefined),
    completeBackgroundTask: vi.fn(async () => undefined),
    addListener: vi.fn(async (ev: string, cb: (e: { taskId: string }) => void) => {
      listeners.set(ev, cb);
      return { remove: async () => undefined };
    }),
  };
  const api = vi.fn(
    async (_path: string, _opts?: unknown) => ({ source: { id: SOURCE } }) as unknown,
  );
  const uploads = {
    addNative: vi.fn((_baby: string, refs: unknown[]) => refs.map(() => `c${++n}`)),
    waitForTerminal: vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, states.get(id) ?? "ingested"])),
    ),
    errorOf: vi.fn((id: string) => errors.get(id)),
    clearFinished: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => []),
  };
  const deps = {
    plugin: () => plugin as unknown as PhotoSyncPlugin,
    kv,
    api: api as never,
    uploads: uploads as never,
    now: () => clock.t,
    hasSession: async () => o.session ?? true,
    installId: async () => DEVICE,
    deviceLabel: () => "iPhone",
    checkSource: async () => o.checkSource ?? "ok",
  } satisfies PhotoSyncDeps;
  return {
    m: new PhotoSyncManager(deps),
    plugin: plugin as never,
    api,
    uploads,
    kv,
    clock,
    listeners,
    states,
    errors,
    deps,
  };
}

const recorded = (h: Harness) =>
  (
    h.plugin.recordOutcomes.mock.calls[0]?.[0] as
      | { outcomes: { id: string; outcome: string }[] }
      | undefined
  )?.outcomes ?? [];

const patchBodies = (h: Harness) =>
  h.api.mock.calls
    .filter(
      ([p, opts]) =>
        String(p).startsWith("/import-sources/") &&
        (opts as { method?: string })?.method === "PATCH",
    )
    .map(([, opts]) => (opts as { body: Record<string, unknown> }).body);

beforeEach(() => {
  window.localStorage.clear();
});

describe("load", () => {
  it("reads the stored config and starts idle (or paused)", async () => {
    const h = make();
    await h.m.load();
    expect(h.m.getStatus()).toMatchObject({ loaded: true, config: CFG, phase: "idle" });
    const p = make({ cfg: { ...CFG, paused: true } });
    await p.m.load();
    expect(p.m.getStatus().phase).toBe("paused");
  });

  it.each([null, "not json", '{"sourceId":1}', "[]"])(
    "a missing or corrupt config (%j) means not set up",
    async (cfg) => {
      const h = make({ cfg: cfg as never });
      await h.m.load();
      expect(h.m.getStatus()).toMatchObject({ loaded: true, config: null, phase: "off" });
    },
  );

  it("notifies subscribers", async () => {
    const h = make();
    const cb = vi.fn();
    h.m.subscribe(cb);
    await h.m.load();
    expect(cb).toHaveBeenCalled();
  });
});

describe("enable (the only place that asks for Photos access)", () => {
  const args = { babyId: BABY, albumId: ALBUM, albumTitle: "Maya", wifiOnly: true };

  it("asks for access when not determined; a refusal creates nothing on the server", async () => {
    const h = make({ cfg: null, auth: "notDetermined" });
    h.plugin.requestAuthorization.mockResolvedValue({ status: "denied" });
    expect(await h.m.enable(args)).toEqual({ ok: false, reason: "permission" });
    expect(h.plugin.requestAuthorization).toHaveBeenCalledTimes(1);
    expect(h.api).not.toHaveBeenCalled();
    expect(h.m.getStatus().config).toBeNull();
  });

  it("limited access is not enough", async () => {
    const h = make({ cfg: null, auth: "limited" });
    expect(await h.m.enable(args)).toEqual({ ok: false, reason: "permission" });
    expect(h.plugin.requestAuthorization).not.toHaveBeenCalled();
    expect(h.api).not.toHaveBeenCalled();
  });

  it("an already granted permission is not asked again", async () => {
    const h = make({ cfg: null });
    expect(await h.m.enable(args)).toEqual({ ok: true });
    expect(h.plugin.requestAuthorization).not.toHaveBeenCalled();
  });

  it("registers the source with the install id, a label, the title and Wi-Fi flag only, then stores the config and starts a manual run", async () => {
    const h = make({ cfg: null, pending: [[]] });
    expect(await h.m.enable({ ...args, albumTitle: "x".repeat(200) })).toEqual({ ok: true });
    const [path, opts] = h.api.mock.calls[0] ?? [];
    expect(path).toBe(`/babies/${BABY}/import-sources`);
    const body = (opts as { body: Record<string, unknown> }).body;
    expect(body).toEqual({
      kind: "apple_photos",
      deviceId: DEVICE,
      deviceLabel: "iPhone",
      albumTitle: "x".repeat(120),
      wifiOnly: true,
    });
    expect(JSON.stringify(h.api.mock.calls)).not.toContain(ALBUM);
    expect(JSON.parse(h.kv.data.get(SYNC_CONFIG_KEY) ?? "{}")).toMatchObject({
      sourceId: SOURCE,
      babyId: BABY,
      albumId: ALBUM,
      wifiOnly: true,
      paused: false,
    });
    expect(window.localStorage.getItem("ll.sync.on")).toBe("1");
    await vi.waitFor(() => expect(h.plugin.listPendingAssets).toHaveBeenCalled());
  });

  it.each([
    [new ApiError(409, "import_source_exists", "x"), "exists"],
    [new ApiError(409, "import_source_limit", "x"), "limit"],
    [new ApiError(409, "baby_trashed", "x"), "trashed"],
    [new ApiError(403, "forbidden", "x"), "forbidden"],
    [new ApiError(404, "not_found", "x"), "forbidden"],
    [new ApiError(0, "network", "x"), "network"],
    [new Error("boom"), "network"],
  ])("maps %s to %s and stores nothing", async (err, reason) => {
    const h = make({ cfg: null });
    h.api.mockRejectedValue(err);
    expect(await h.m.enable(args)).toEqual({ ok: false, reason });
    expect(h.m.getStatus().config).toBeNull();
    expect(h.kv.data.size).toBe(0);
  });

  it("changing the album resets the old ledger; changing the baby also deletes the old server row", async () => {
    const h = make({ pending: [[]] });
    await h.m.enable({ ...args, albumId: "OTHER-ALBUM" });
    expect(h.plugin.resetLedger).toHaveBeenCalledWith({ albumId: ALBUM });
    expect(
      h.api.mock.calls.some(
        ([p, o]) =>
          p === `/import-sources/${SOURCE}` && (o as { method?: string }).method === "DELETE",
      ),
    ).toBe(false);
    const g = make({ pending: [[]] });
    await g.m.enable({ ...args, babyId: BABY2 });
    expect(
      g.api.mock.calls.some(
        ([p, o]) =>
          p === `/import-sources/${SOURCE}` && (o as { method?: string }).method === "DELETE",
      ),
    ).toBe(true);
  });
});

describe("runSync gates", () => {
  it("does nothing without a config or without a session", async () => {
    const a = make({ cfg: null });
    await a.m.runSync("manual");
    expect(a.plugin.conditions).not.toHaveBeenCalled();
    const b = make({ session: false });
    await b.m.runSync("manual");
    expect(b.plugin.listPendingAssets).not.toHaveBeenCalled();
  });

  it("the server removed this phone's row (or the user is no longer an admin): sync switches off locally, ledger kept, user told", async () => {
    const h = make({ checkSource: "gone" });
    await h.m.runSync("launch");
    expect(h.m.getStatus()).toMatchObject({ config: null, phase: "off", notice: "removed" });
    expect(h.kv.data.has(SYNC_CONFIG_KEY)).toBe(false);
    expect(h.plugin.resetLedger).not.toHaveBeenCalled();
    expect(h.plugin.listPendingAssets).not.toHaveBeenCalled();
  });

  it("an unreachable server check lets the run continue", async () => {
    const h = make({ checkSource: "unknown", pending: [[]] });
    await h.m.runSync("launch");
    expect(h.plugin.listPendingAssets).toHaveBeenCalled();
  });

  it("launch/resume/background runs within a minute of the last run do nothing; manual always runs", async () => {
    const h = make({ pending: [[], [], [], []] });
    await h.m.runSync("launch");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    h.clock.t += 30_000;
    await h.m.runSync("resume");
    await h.m.runSync("background");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(2);
    h.clock.t += 61_000;
    await h.m.runSync("resume");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(3);
  });

  it("a paused sync does not run (even manual)", async () => {
    const h = make({ cfg: { ...CFG, paused: true } });
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).not.toHaveBeenCalled();
    expect(h.m.getStatus().phase).toBe("paused");
  });

  it.each(["denied", "limited", "restricted", "notDetermined"])(
    "access %s: pauses with permission_denied and never prompts",
    async (auth) => {
      const h = make({ auth });
      await h.m.runSync("manual");
      expect(h.plugin.requestAuthorization).not.toHaveBeenCalled();
      expect(patchBodies(h)).toEqual([{ lastError: "permission_denied", paused: true }]);
      expect(h.m.getStatus()).toMatchObject({ phase: "error", lastError: "permission_denied" });
      expect(h.m.getStatus().config?.paused).toBe(true);
      expect(h.plugin.listPendingAssets).not.toHaveBeenCalled();
    },
  );

  it("Wi-Fi only without Wi-Fi waits (no listing), without the restriction it runs", async () => {
    const h = make({ wifi: false });
    await h.m.runSync("manual");
    expect(h.m.getStatus().phase).toBe("waiting_wifi");
    expect(h.plugin.listPendingAssets).not.toHaveBeenCalled();
    const g = make({ wifi: false, cfg: { ...CFG, wifiOnly: false }, pending: [[]] });
    await g.m.runSync("manual");
    expect(g.plugin.listPendingAssets).toHaveBeenCalled();
  });

  it.each([
    ["low power mode", { lowPower: true }],
    ["a serious thermal state", { thermal: "serious" }],
    ["a critical thermal state", { thermal: "critical" }],
  ])("%s skips the run", async (_n, over) => {
    const h = make(over);
    await h.m.runSync("manual");
    expect(h.m.getStatus().phase).toBe("low_power");
    expect(h.plugin.listPendingAssets).not.toHaveBeenCalled();
  });

  it("a fair thermal state still runs", async () => {
    const h = make({ thermal: "fair", pending: [[]] });
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).toHaveBeenCalled();
  });

  it("a missing album pauses with album_missing", async () => {
    const h = make();
    h.plugin.listPendingAssets.mockResolvedValue({ assets: [], remaining: 0, albumExists: false });
    await h.m.runSync("manual");
    expect(patchBodies(h)).toEqual([{ lastError: "album_missing", paused: true }]);
    expect(h.m.getStatus()).toMatchObject({ phase: "error", lastError: "album_missing" });
  });

  it("an exception inside a run never escapes", async () => {
    const h = make();
    h.plugin.listPendingAssets.mockRejectedValue(new Error("PhotoKit exploded"));
    await expect(h.m.runSync("manual")).resolves.toBeUndefined();
    expect(h.m.getStatus().phase).toBe("idle");
    expect(h.plugin.scheduleBackgroundRefresh).not.toHaveBeenCalled();
  });
});

describe("a sync run", () => {
  it("foreground: lists SYNC_FOREGROUND_BATCH, uploads on the sync lane with the sha256 lowercased, records outcomes, reports deltas", async () => {
    const h = make({ pending: [[asset(1), asset(2)], []] });
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).toHaveBeenNthCalledWith(1, {
      albumId: ALBUM,
      limit: SYNC_FOREGROUND_BATCH,
    });
    const [baby, refs, details, opts] = h.uploads.addNative?.mock.calls[0] ?? [];
    expect(baby).toBe(BABY);
    expect(details).toBeUndefined();
    expect(opts).toEqual({ lane: "sync", wifiOnly: true });
    expect((refs as { sha256: string; takenAt: string }[])[0]).toMatchObject({
      sha256: "ab".repeat(32),
      takenAt: "2026-03-01T10:00:00Z",
    });
    expect(h.plugin.recordOutcomes).toHaveBeenCalledWith({
      albumId: ALBUM,
      outcomes: [
        { id: "ASSET-1/L0/001", outcome: "done" },
        { id: "ASSET-2/L0/001", outcome: "done" },
      ],
    });
    const bodies = patchBodies(h);
    expect(bodies[0]).toMatchObject({
      lastTrigger: "manual",
      importedDelta: 2,
      duplicateDelta: 0,
      failedDelta: 0,
      skippedDelta: 0,
    });
    expect(typeof bodies[0]?.lastSyncAt).toBe("string");
    expect(h.uploads.clearFinished).toHaveBeenCalledWith(BABY, "sync");
    expect(h.plugin.discardFiles).toHaveBeenCalled();
    expect(h.plugin.scheduleBackgroundRefresh).toHaveBeenCalledTimes(1);
    expect(h.m.getStatus()).toMatchObject({ phase: "idle", progress: null, lastError: null });
  });

  it("never sends an asset id, album id, file name or path to the server", async () => {
    const h = make({ pending: [[asset(1)], []] });
    await h.m.runSync("manual");
    const sent = JSON.stringify(h.api.mock.calls);
    expect(sent).not.toMatch(/ASSET-|ALBUM-LOCAL|IMG_|ll-uploads|\/private\/var/);
  });

  it("background runs take SYNC_BACKGROUND_BATCH and exactly one batch", async () => {
    const h = make({ pending: [[asset(1)], [asset(2)], []] });
    await h.m.runSync("background");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    expect(h.plugin.listPendingAssets).toHaveBeenCalledWith({
      albumId: ALBUM,
      limit: SYNC_BACKGROUND_BATCH,
    });
  });

  it("foreground keeps going batch after batch until the album is drained", async () => {
    const h = make({ pending: [[asset(1)], [asset(2)], [asset(3)], []] });
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(4);
    expect(h.plugin.recordOutcomes).toHaveBeenCalledTimes(3);
  });

  it("stops between batches when Wi-Fi is lost", async () => {
    const h = make({ pending: [[asset(1)], [asset(2)], []] });
    let calls = 0;
    h.plugin.conditions.mockImplementation(async () => ({
      wifi: ++calls < 2,
      expensive: false,
      lowPowerMode: false,
      thermalState: "nominal",
    }));
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    expect(h.m.getStatus().phase).toBe("waiting_wifi");
  });

  it("maps upload results: ingested/completed -> done, duplicate -> duplicate, unsupported codes -> skipped, other failures -> failed", async () => {
    const h = make({ pending: [[asset(1), asset(2), asset(3), asset(4), asset(5)], []] });
    h.states.set("c1", "completed");
    h.states.set("c2", "duplicate");
    h.states.set("c3", "failed");
    h.errors.set("c3", "unsupported_media_type");
    h.states.set("c4", "failed");
    h.errors.set("c4", "internal");
    await h.m.runSync("manual");
    const outcomes = recorded(h);
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "done",
      "duplicate",
      "skipped",
      "done",
      "failed",
    ]);
    expect(patchBodies(h)[0]).toMatchObject({
      importedDelta: 2,
      duplicateDelta: 1,
      failedDelta: 1,
      skippedDelta: 1,
    });
  });

  it("export failures: unsupported -> skipped, others (iCloud, unavailable) -> failed", async () => {
    const h = make({
      pending: [[asset(1), asset(2), asset(3)], []],
      files: [file(1)],
      failedExport: [
        { id: "ASSET-2/L0/001", reason: "unsupported" },
        { id: "ASSET-3/L0/001", reason: "icloud" },
      ],
    });
    await h.m.runSync("manual");
    const outcomes = recorded(h);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { id: "ASSET-2/L0/001", outcome: "skipped" },
        { id: "ASSET-3/L0/001", outcome: "failed" },
        { id: "ASSET-1/L0/001", outcome: "done" },
      ]),
    );
  });

  it("the free-tier cap stops the run with free_tier_limit; the asset is NOT recorded (it stays pending for after an upgrade)", async () => {
    const h = make({ pending: [[asset(1), asset(2)], [asset(3)]] });
    h.states.set("c2", "failed");
    h.errors.set("c2", "free_tier_limit");
    await h.m.runSync("manual");
    const outcomes = recorded(h);
    expect(outcomes.map((o) => o.id)).toEqual(["ASSET-1/L0/001"]);
    expect(patchBodies(h)[0]).toMatchObject({ lastError: "free_tier_limit", importedDelta: 1 });
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    expect(h.m.getStatus()).toMatchObject({ phase: "error", lastError: "free_tier_limit" });
  });

  it("after a free_tier_limit stop, automatic triggers wait out a 6 hour cooldown; manual retries at once", async () => {
    const h = make({ pending: [[asset(1)], [asset(1)], [asset(1)], [asset(1)]] });
    h.states.set("c1", "failed");
    h.errors.set("c1", "free_tier_limit");
    await h.m.runSync("manual");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    h.clock.t += 2 * 3_600_000;
    await h.m.runSync("resume");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    h.clock.t += 5 * 3_600_000;
    await h.m.runSync("resume");
    expect(h.plugin.listPendingAssets.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("when every upload failed on the network, nothing is recorded (no attempt burned) and the run stops with network", async () => {
    const h = make({ pending: [[asset(1), asset(2)], [asset(3)]] });
    for (const id of ["c1", "c2"]) {
      h.states.set(id, "failed");
      h.errors.set(id, "network");
    }
    await h.m.runSync("manual");
    expect(h.plugin.recordOutcomes).not.toHaveBeenCalled();
    expect(patchBodies(h)[0]).toMatchObject({
      lastError: "network",
      importedDelta: 0,
      failedDelta: 0,
    });
    expect(h.m.getStatus().lastError).toBe("network");
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
  });

  it("a partial network failure still records the rest (and the failed one counts an attempt)", async () => {
    const h = make({ pending: [[asset(1), asset(2)], []] });
    h.states.set("c2", "failed");
    h.errors.set("c2", "network");
    await h.m.runSync("manual");
    const outcomes = recorded(h);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["done", "failed"]);
  });

  it("a successful run after an error clears lastError on the server", async () => {
    const h = make({ pending: [[asset(1)], []] });
    h.m.subscribe(() => undefined);
    await h.m.load();
    (h.m as unknown as { set: (c: object) => void }).set({ lastError: "network", phase: "error" });
    await h.m.runSync("manual");
    expect(patchBodies(h)[0]).toMatchObject({ lastError: null });
    expect(h.m.getStatus().lastError).toBeNull();
  });

  it("assets still uploading when the run is aborted are cancelled, not recorded", async () => {
    const h = make({ pending: [[asset(1)], []] });
    h.states.set("c1", "uploading");
    await h.m.runSync("manual");
    expect(h.uploads.cancel).toHaveBeenCalledWith("c1");
    expect(h.plugin.recordOutcomes).not.toHaveBeenCalled();
  });

  it("a 404 on a PATCH (the row was deleted server-side) switches the sync off with a notice", async () => {
    const h = make({ pending: [[asset(1)], []] });
    h.api.mockImplementation(async (_p: string, o?: { method?: string }) => {
      if (o?.method === "PATCH") throw new ApiError(404, "not_found", "gone");
      return { source: { id: SOURCE } };
    });
    await h.m.runSync("manual");
    expect(h.m.getStatus()).toMatchObject({ config: null, notice: "removed" });
  });
});

describe("single flight and background tasks", () => {
  it("concurrent runSync calls share one run", async () => {
    const h = make({ pending: [[asset(1)], []] });
    const a = h.m.runSync("manual");
    const b = h.m.runSync("resume");
    await Promise.all([a, b]);
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(2); // one run: one batch + the drained list
  });

  it("a background run completes the OS task with success and re-schedules", async () => {
    const h = make({ pending: [[asset(1)]] });
    await h.m.runSync("background", { taskId: "task-1" });
    expect(h.plugin.completeBackgroundTask).toHaveBeenCalledWith({
      taskId: "task-1",
      success: true,
    });
    expect(h.plugin.scheduleBackgroundRefresh).toHaveBeenCalled();
  });

  it("a background task arriving during a foreground run is still completed", async () => {
    const h = make({ pending: [[asset(1)], []] });
    const fg = h.m.runSync("manual");
    const bg = h.m.runSync("background", { taskId: "task-2" });
    await Promise.all([fg, bg]);
    expect(h.plugin.completeBackgroundTask).toHaveBeenCalledWith({
      taskId: "task-2",
      success: true,
    });
  });

  it("a gated background run (no Wi-Fi) still completes its task", async () => {
    const h = make({ wifi: false });
    await h.m.runSync("background", { taskId: "task-3" });
    expect(h.plugin.completeBackgroundTask).toHaveBeenCalledWith({
      taskId: "task-3",
      success: true,
    });
  });

  it("an exception in a background run reports failure to the OS", async () => {
    const h = make();
    h.plugin.listPendingAssets.mockRejectedValue(new Error("x"));
    await h.m.runSync("background", { taskId: "task-4" });
    expect(h.plugin.completeBackgroundTask).toHaveBeenCalledWith({
      taskId: "task-4",
      success: false,
    });
  });

  it("init registers both native listeners once; backgroundSync starts a background run with the task id", async () => {
    const h = make({ pending: [[]] });
    await h.m.init();
    await h.m.init();
    expect(h.plugin.addListener).toHaveBeenCalledTimes(2);
    h.listeners.get("backgroundSync")?.({ taskId: "bg-1" });
    await vi.waitFor(() =>
      expect(h.plugin.completeBackgroundTask).toHaveBeenCalledWith({
        taskId: "bg-1",
        success: true,
      }),
    );
  });

  it("backgroundSyncExpired stops after the current batch", async () => {
    const h = make({ pending: [[asset(1)], [asset(2)], [asset(3)], []] });
    await h.m.init();
    h.uploads.waitForTerminal?.mockImplementationOnce(async (ids: string[]) => {
      h.listeners.get("backgroundSyncExpired")?.({ taskId: "bg-9" });
      return new Map(ids.map((id) => [id, "ingested"]));
    });
    await h.m.runSync("background", { taskId: "bg-9" });
    expect(h.plugin.listPendingAssets).toHaveBeenCalledTimes(1);
    expect(h.plugin.recordOutcomes).toHaveBeenCalledTimes(1);
    expect(h.plugin.completeBackgroundTask).toHaveBeenCalledWith({ taskId: "bg-9", success: true });
  });

  it("init survives a missing plugin (web) and can retry", async () => {
    const h = make();
    h.plugin.addListener.mockRejectedValueOnce(new Error("not implemented"));
    await expect(h.m.init()).resolves.toBeUndefined();
    await h.m.init();
    expect(h.plugin.addListener).toHaveBeenCalledTimes(3);
  });
});

describe("settings actions", () => {
  it("pause patches the server and stores it; resume clears the error and starts a manual run", async () => {
    const h = make({ pending: [[]] });
    await h.m.load();
    await h.m.setPaused(true);
    expect(patchBodies(h)).toEqual([{ paused: true }]);
    expect(h.m.getStatus()).toMatchObject({ phase: "paused" });
    expect(JSON.parse(h.kv.data.get(SYNC_CONFIG_KEY) ?? "{}").paused).toBe(true);
    await h.m.setPaused(false);
    expect(patchBodies(h)[1]).toEqual({ paused: false, lastError: null });
    await vi.waitFor(() => expect(h.plugin.listPendingAssets).toHaveBeenCalled());
  });

  it("Wi-Fi only is patched and stored", async () => {
    const h = make();
    await h.m.load();
    await h.m.setWifiOnly(false);
    expect(patchBodies(h)).toEqual([{ wifiOnly: false }]);
    expect(JSON.parse(h.kv.data.get(SYNC_CONFIG_KEY) ?? "{}").wifiOnly).toBe(false);
  });

  it("stop syncing deletes the server row, resets this album's ledger, forgets the config; photos are untouched", async () => {
    const h = make();
    await h.m.load();
    await h.m.disable();
    expect(h.api).toHaveBeenCalledWith(`/import-sources/${SOURCE}`, { method: "DELETE" });
    expect(h.plugin.resetLedger).toHaveBeenCalledWith({ albumId: ALBUM });
    expect(h.m.getStatus()).toMatchObject({ config: null, phase: "off" });
    expect(h.kv.data.has(SYNC_CONFIG_KEY)).toBe(false);
    expect(window.localStorage.getItem("ll.sync.on")).toBeNull();
    // nothing in the plugin deletes photos
    expect(Object.keys(h.plugin).some((k) => /delete(Photo|Asset)/i.test(k))).toBe(false);
  });

  it("stop syncing still works offline", async () => {
    const h = make();
    h.api.mockRejectedValue(new ApiError(0, "network", "offline"));
    await h.m.load();
    await h.m.disable();
    expect(h.m.getStatus().config).toBeNull();
  });

  it("sign-out pauses the row as signed_out, then wipes the ledger and config", async () => {
    const h = make();
    await h.m.onSignOut();
    expect(patchBodies(h)).toEqual([{ paused: true, lastError: "signed_out" }]);
    expect(h.plugin.resetLedger).toHaveBeenCalledWith();
    expect(h.kv.data.has(SYNC_CONFIG_KEY)).toBe(false);
    expect(h.m.getStatus().config).toBeNull();
  });

  it("sign-out without sync set up does nothing", async () => {
    const h = make({ cfg: null });
    await h.m.onSignOut();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.plugin.resetLedger).not.toHaveBeenCalled();
  });

  it("clearLocal wipes without calling the API (account deletion / lost session)", async () => {
    const h = make();
    await h.m.load();
    await h.m.clearLocal();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.plugin.resetLedger).toHaveBeenCalled();
    expect(h.m.getStatus().config).toBeNull();
  });
});

describe("reads", () => {
  it("authorization/albums degrade safely when the plugin throws", async () => {
    const h = make();
    h.plugin.authorizationStatus.mockRejectedValue(new Error("x"));
    h.plugin.listAlbums.mockRejectedValue(new Error("x"));
    expect(await h.m.authorization()).toBe("denied");
    expect(await h.m.albums()).toEqual([]);
  });

  it("requestAuthorization only prompts while not determined", async () => {
    const h = make({ auth: "denied" });
    expect(await h.m.requestAuthorization()).toBe("denied");
    expect(h.plugin.requestAuthorization).not.toHaveBeenCalled();
    const g = make({ auth: "notDetermined" });
    expect(await g.m.requestAuthorization()).toBe("authorized");
    expect(g.plugin.requestAuthorization).toHaveBeenCalledTimes(1);
  });
});
