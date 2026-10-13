import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_STATE_KEY,
  type AppUpdateManifestResponse,
} from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryTokenStore, setNativePlatform, stubFetch } from "../../testing/native";
import type { NativePlatform } from "../platform";
import { type AppUpdaterDeps, createAppUpdater } from "./appUpdate";
import { appUpdateStatus, type UpdaterInfo } from "./appUpdateStatus";

// Live-update client (docs/plans/step-14.md 2.8, D3, D4, D9): native only, interval for automatic
// triggers, idle gate (uploads / album sync), envelope passed to the native stage() unchanged,
// outcomes to the status store, only { lastCheckAt } stored, nothing logged.

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const ENVELOPE = {
  manifestJson: '{"schema":1,"version":"bbbbbbbbbbbbbbbb","baseUrl":"https://tinyglow.app"}',
  signature: "MEUCIQDsigsigsig==",
  keyId: "dev",
};

const shellInfo = (o: Partial<UpdaterInfo> = {}): UpdaterInfo => ({
  nativeVersion: "1.4.0",
  nativeBuild: 12,
  builtinVersion: A,
  currentVersion: A,
  currentSource: "builtin",
  stagedVersion: null,
  androidPushConfigured: true,
  ...o,
});

/** A plugin shaped like Capacitor's Proxy: `then` answers with a never-settling call. */
function fakePlugin() {
  const m = {
    info: vi.fn(async () => shellInfo() as unknown),
    stage: vi.fn(async (_e: unknown) => ({ outcome: "staged" as string, version: B, bytes: 1 })),
    notifyAppReady: vi.fn(async () => undefined),
    applyNow: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  };
  const proxy = new Proxy(m, {
    get(t, p) {
      if (p === "then") return () => new Promise(() => undefined);
      return Reflect.get(t, p);
    },
  });
  return { m, proxy };
}

function setup(over: Partial<AppUpdaterDeps> = {}) {
  const plugin = fakePlugin();
  let t = 1_000_000_000_000;
  const store = { last: null as number | null, writes: [] as number[] };
  const state = { uploads: false, syncing: false, platform: "ios" as NativePlatform | null };
  const fetchManifest = vi.fn(
    async (_q: string): Promise<AppUpdateManifestResponse> => ({ update: ENVELOPE }),
  );
  const deps: AppUpdaterDeps = {
    platform: () => state.platform,
    plugin: async () => ({ U: plugin.proxy as never }),
    fetchManifest,
    uploadsActive: () => state.uploads,
    syncing: () => state.syncing,
    now: () => t,
    readLastCheckAt: () => store.last,
    writeLastCheckAt: (at) => {
      store.last = at;
      store.writes.push(at);
    },
    ...over,
  };
  const u = createAppUpdater(deps);
  return {
    u,
    plugin: plugin.m,
    fetchManifest,
    store,
    state,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

// Default wiring (`appUpdater`): the real registerPlugin is replaced by a thenable-trap Proxy.
const plugin = vi.hoisted(() => ({
  info: vi.fn(),
  stage: vi.fn(),
  notifyAppReady: vi.fn(),
  applyNow: vi.fn(),
  reset: vi.fn(),
}));
// Only registerPlugin: the real @capacitor/core would replace the test's `window.Capacitor`.
vi.mock("@capacitor/core", () => ({
  registerPlugin: (name: string) => {
    if (name !== "TinyglowUpdater") throw new Error(`unexpected plugin ${name}`);
    return new Proxy(plugin, {
      get(t, p) {
        if (p === "then") return () => new Promise(() => undefined);
        return Reflect.get(t, p);
      },
    });
  },
}));

beforeEach(() => appUpdateStatus.reset());

describe("checkForUpdate: gates", () => {
  it("web: skipped, touches nothing", async () => {
    const s = setup();
    s.state.platform = null;
    expect(await s.u.checkForUpdate("manual")).toBe("skipped");
    expect(await s.u.info()).toBeNull();
    await s.u.notifyAppReady();
    expect(await s.u.applyNow()).toBe("none");
    expect(await s.u.reset()).toBe(false);
    for (const f of Object.values(s.plugin)) expect(f).not.toHaveBeenCalled();
    expect(s.fetchManifest).not.toHaveBeenCalled();
  });

  it("launch/resume wait 6 h after the last check; manual ignores the interval", async () => {
    const s = setup();
    s.store.last = s.now() - APP_UPDATE_CHECK_INTERVAL_MS + 1;
    expect(await s.u.checkForUpdate("launch")).toBe("skipped");
    expect(await s.u.checkForUpdate("resume")).toBe("skipped");
    expect(s.fetchManifest).not.toHaveBeenCalled();
    expect(await s.u.checkForUpdate("manual")).toBe("staged");
    expect(s.fetchManifest).toHaveBeenCalledTimes(1);
    s.store.last = s.now() - APP_UPDATE_CHECK_INTERVAL_MS;
    expect(await s.u.checkForUpdate("launch")).toBe("staged");
  });

  it("a lastCheckAt in the future (clock moved back) does not block checks", async () => {
    const s = setup();
    s.store.last = s.now() + 60_000;
    expect(await s.u.checkForUpdate("launch")).toBe("staged");
  });

  it.each([
    ["an active upload", { uploads: true, syncing: false }],
    ["an album sync", { uploads: false, syncing: true }],
  ])(
    "idle gate: %s => busy, nothing fetched or downloaded, interval not consumed",
    async (_n, st) => {
      const s = setup();
      Object.assign(s.state, st);
      expect(await s.u.checkForUpdate("launch")).toBe("busy");
      expect(s.fetchManifest).not.toHaveBeenCalled();
      expect(s.plugin.stage).not.toHaveBeenCalled();
      expect(s.store.writes).toEqual([]);
      expect(appUpdateStatus.get().outcome).toBeNull();
      expect(await s.u.checkForUpdate("manual")).toBe("busy");
      expect(appUpdateStatus.get().outcome).toBe("busy");
      Object.assign(s.state, { uploads: false, syncing: false });
      expect(await s.u.checkForUpdate("resume")).toBe("staged");
    },
  );

  it("a busy probe that throws counts as busy", async () => {
    const s = setup({
      uploadsActive: () => {
        throw new Error("x");
      },
    });
    expect(await s.u.checkForUpdate("manual")).toBe("busy");
  });

  it("uploads starting during the server call: no download", async () => {
    const s = setup();
    s.fetchManifest.mockImplementation(async () => {
      s.state.uploads = true;
      return { update: ENVELOPE };
    });
    expect(await s.u.checkForUpdate("launch")).toBe("busy");
    expect(s.plugin.stage).not.toHaveBeenCalled();
    expect(appUpdateStatus.get().phase).toBe("idle");
  });

  it("a shell without the updater (info missing / malformed / hanging) is skipped", async () => {
    const s = setup();
    s.plugin.info.mockResolvedValue({ nativeVersion: 1 });
    expect(await s.u.checkForUpdate("manual")).toBe("skipped");
    expect(s.fetchManifest).not.toHaveBeenCalled();
    s.plugin.info.mockRejectedValue(new Error("UNIMPLEMENTED"));
    expect(await s.u.checkForUpdate("manual")).toBe("skipped");
    expect(appUpdateStatus.get()).toMatchObject({ info: null, infoLoaded: true, phase: "idle" });
  });

  it("info() that never settles times out after 5 s (no hang)", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.plugin.info.mockImplementation(() => new Promise(() => undefined));
      const p = s.u.checkForUpdate("manual");
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await p).toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("checkForUpdate: server and stage", () => {
  it("asks with platform, native build and current content id", async () => {
    const s = setup();
    s.state.platform = "android";
    await s.u.checkForUpdate("manual");
    const q = new URLSearchParams(s.fetchManifest.mock.calls[0]?.[0]);
    expect(Object.fromEntries(q)).toEqual({ platform: "android", native: "12", current: A });
  });

  it("omits current when the shell reports a non-content-id version", async () => {
    const s = setup();
    s.plugin.info.mockResolvedValue(shellInfo({ currentVersion: "builtin" }));
    await s.u.checkForUpdate("manual");
    expect(new URLSearchParams(s.fetchManifest.mock.calls[0]?.[0]).has("current")).toBe(false);
  });

  it("hands the envelope to stage() unchanged (only the three fields)", async () => {
    const s = setup();
    s.fetchManifest.mockResolvedValue({ update: { ...ENVELOPE, extra: "x" } as never });
    expect(await s.u.checkForUpdate("manual")).toBe("staged");
    expect(s.plugin.stage).toHaveBeenCalledWith(ENVELOPE);
    expect(s.store.writes).toHaveLength(1);
    expect(appUpdateStatus.get()).toMatchObject({ phase: "idle", outcome: "staged" });
    // info refreshed after staging (About shows "Update ready")
    expect(s.plugin.info).toHaveBeenCalledTimes(2);
  });

  it.each(["up_to_date", "native_too_old", "disabled", "unavailable"] as const)(
    "server reason %s: recorded, no stage, interval consumed",
    async (reason) => {
      const s = setup();
      s.fetchManifest.mockResolvedValue({ update: null, reason });
      expect(await s.u.checkForUpdate("launch")).toBe(reason);
      expect(s.plugin.stage).not.toHaveBeenCalled();
      expect(s.store.writes).toHaveLength(1);
      expect(appUpdateStatus.get().outcome).toBe(reason);
    },
  );

  it.each([
    ["wifi_required", false],
    ["constrained", false],
    ["no_space", false],
    ["network", false],
    ["verify_failed", true],
    ["rejected", true],
    ["already_staged", true],
    ["native_too_old", true],
  ] as const)("stage outcome %s (settles the interval: %s)", async (outcome, settles) => {
    const s = setup();
    s.plugin.stage.mockResolvedValue({ outcome, version: B, bytes: 1 });
    expect(await s.u.checkForUpdate("resume")).toBe(outcome);
    expect(s.store.writes.length > 0).toBe(settles);
    expect(appUpdateStatus.get().outcome).toBe(outcome);
  });

  it("an unknown or missing stage outcome, or a throwing stage, is error", async () => {
    const s = setup();
    s.plugin.stage.mockResolvedValue({ outcome: "pwned", version: B, bytes: 1 });
    expect(await s.u.checkForUpdate("manual")).toBe("error");
    s.plugin.stage.mockRejectedValue(new Error("boom"));
    expect(await s.u.checkForUpdate("manual")).toBe("error");
    expect(s.store.writes).toEqual([]);
  });

  it("a failing server call is error and the next trigger retries (interval not consumed)", async () => {
    const s = setup();
    s.fetchManifest.mockRejectedValue(new Error("offline"));
    expect(await s.u.checkForUpdate("launch")).toBe("error");
    expect(s.store.writes).toEqual([]);
    s.fetchManifest.mockResolvedValue({ update: null, reason: "up_to_date" });
    expect(await s.u.checkForUpdate("resume")).toBe("up_to_date");
  });

  it("single-flight: concurrent triggers share one check", async () => {
    const s = setup();
    let release: (v: AppUpdateManifestResponse) => void = () => undefined;
    s.fetchManifest.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const a = s.u.checkForUpdate("launch");
    const b = s.u.checkForUpdate("manual");
    await vi.waitFor(() => expect(s.fetchManifest).toHaveBeenCalled());
    expect(appUpdateStatus.get().phase).toBe("checking");
    release({ update: null, reason: "up_to_date" });
    expect(await a).toBe("up_to_date");
    expect(await b).toBe("up_to_date");
    expect(s.fetchManifest).toHaveBeenCalledTimes(1);
  });

  it("phase goes checking -> downloading -> idle", async () => {
    const s = setup();
    const phases: string[] = [];
    const off = appUpdateStatus.subscribe(() => phases.push(appUpdateStatus.get().phase));
    await s.u.checkForUpdate("manual");
    off();
    expect(phases).toContain("checking");
    expect(phases).toContain("downloading");
    expect(phases.at(-1)).toBe("idle");
  });

  it("never logs anything (no body, URL, signature or version)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    const s = setup();
    await s.u.checkForUpdate("manual");
    s.plugin.stage.mockRejectedValue(new Error(ENVELOPE.signature));
    await s.u.checkForUpdate("manual");
    s.fetchManifest.mockRejectedValue(new Error("https://tinyglow.app/api"));
    await s.u.checkForUpdate("manual");
    for (const sp of spies) {
      expect(sp).not.toHaveBeenCalled();
      sp.mockRestore();
    }
  });
});

describe("notifyAppReady / applyNow / reset", () => {
  it("notifyAppReady calls the plugin and swallows failures", async () => {
    const s = setup();
    await s.u.notifyAppReady();
    expect(s.plugin.notifyAppReady).toHaveBeenCalledTimes(1);
    s.plugin.notifyAppReady.mockRejectedValue(new Error("old shell"));
    await expect(s.u.notifyAppReady()).resolves.toBeUndefined();
  });

  it("applyNow: none without a staged bundle; busy while uploading; applied otherwise", async () => {
    const s = setup();
    expect(await s.u.applyNow()).toBe("none");
    s.plugin.info.mockResolvedValue(shellInfo({ stagedVersion: B }));
    s.state.uploads = true;
    expect(await s.u.applyNow()).toBe("busy");
    expect(s.plugin.applyNow).not.toHaveBeenCalled();
    s.state.uploads = false;
    expect(await s.u.applyNow()).toBe("applied");
    expect(s.plugin.applyNow).toHaveBeenCalledTimes(1);
    s.plugin.applyNow.mockRejectedValue(new Error("x"));
    expect(await s.u.applyNow()).toBe("failed");
  });

  it("reset clears lastCheckAt so the next launch checks again", async () => {
    const s = setup();
    s.store.last = s.now();
    expect(await s.u.reset()).toBe(true);
    expect(s.plugin.reset).toHaveBeenCalledTimes(1);
    expect(s.store.last).toBe(0);
    s.plugin.reset.mockRejectedValue(new Error("x"));
    expect(await s.u.reset()).toBe(false);
  });

  it("info is cached per session unless fresh is asked", async () => {
    const s = setup();
    await s.u.info();
    await s.u.info();
    expect(s.plugin.info).toHaveBeenCalledTimes(1);
    await s.u.info({ fresh: true });
    expect(s.plugin.info).toHaveBeenCalledTimes(2);
  });
});

describe("default wiring", () => {
  afterEach(() => {
    setNativePlatform(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("calls GET /app-update/manifest as a native client and stores only { lastCheckAt }", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    setNativePlatform("ios");
    vi.resetModules();
    const store = await import("../tokenStore");
    store.setTokenStore(memoryTokenStore(null));
    plugin.info.mockResolvedValue(shellInfo());
    plugin.stage.mockResolvedValue({ outcome: "staged", version: B, bytes: 10 });
    const f = stubFetch(() => jsonResponse({ update: ENVELOPE }));
    const mod = await import("./appUpdate");
    expect(await mod.checkForUpdate("manual")).toBe("staged");
    const call = f.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toContain("/app-update/manifest?");
    expect(call?.url).toContain("platform=ios");
    expect(call?.headers.get("x-tinyglow-client")).toBe("native");
    expect(plugin.stage).toHaveBeenCalledWith(ENVELOPE);
    const keys = Object.keys(window.localStorage);
    expect(keys).toContain(APP_UPDATE_STATE_KEY);
    const saved = JSON.parse(window.localStorage.getItem(APP_UPDATE_STATE_KEY) ?? "{}");
    expect(Object.keys(saved)).toEqual(["lastCheckAt"]);
    const all = JSON.stringify({ ...window.localStorage });
    expect(all).not.toContain(ENVELOPE.signature);
    expect(all).not.toContain("tinyglow.app");
    // resume within 6 h: skipped from storage
    expect(await mod.checkForUpdate("resume")).toBe("skipped");
  });

  it("a corrupt stored state is ignored (check runs)", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    setNativePlatform("android");
    window.localStorage.setItem(APP_UPDATE_STATE_KEY, "{not json");
    vi.resetModules();
    const store = await import("../tokenStore");
    store.setTokenStore(memoryTokenStore(null));
    plugin.info.mockResolvedValue(shellInfo());
    stubFetch(() => jsonResponse({ update: null, reason: "up_to_date" }));
    const mod = await import("./appUpdate");
    expect(await mod.checkForUpdate("launch")).toBe("up_to_date");
  });
});
