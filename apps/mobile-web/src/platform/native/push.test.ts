import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, memoryTokenStore, setNativePlatform, stubFetch } from "../../testing/native";

// Push client (docs/plans/step-9.md 2.8, 2.15): opt-in only, no registration on an Android build
// without FCM, the device token goes to the API once and is never logged, taps are validated.

type Listener = (e: unknown) => void;
const listeners = new Map<string, Listener>();
// Like a real Capacitor plugin: a Proxy that answers EVERY property, `then` included, with a native
// method call that never settles. Anything that resolves a promise with the plugin itself hangs.
const PN = vi.hoisted(() => {
  const methods = {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    register: vi.fn(),
    addListener: vi.fn(),
    createChannel: vi.fn(),
  };
  return new Proxy(methods, {
    get(target, prop) {
      if (prop === "then") return () => new Promise(() => undefined);
      return Reflect.get(target, prop);
    },
  });
});
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: PN }));
// Shell facts from the live updater (step 14 D10): `null` = a shell without the updater plugin.
const updaterInfo = vi.hoisted(() => vi.fn());
vi.mock("./appUpdate", () => ({ updaterInfo }));

const API = "https://api.example.test";
const TOKEN = `apns-${"ab".repeat(32)}`;
const BABY = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";
const device = {
  device: {
    id: "33333333-3333-4333-8333-333333333333",
    platform: "ios",
    createdAt: "2026-10-09T10:00:00.000Z",
  },
};

async function load() {
  vi.resetModules();
  const push = await import("./push");
  const store = await import("../tokenStore");
  store.setTokenStore(memoryTokenStore({ accessToken: "AT", refreshToken: "RT" }));
  return push;
}

beforeEach(() => {
  listeners.clear();
  updaterInfo.mockReset().mockResolvedValue(null);
  PN.checkPermissions.mockReset().mockResolvedValue({ receive: "granted" });
  PN.requestPermissions.mockReset().mockResolvedValue({ receive: "granted" });
  PN.register.mockReset().mockImplementation(async () => {
    setTimeout(() => listeners.get("registration")?.({ value: TOKEN }), 0);
  });
  PN.addListener.mockReset().mockImplementation(async (name: string, cb: Listener) => {
    listeners.set(name, cb);
    return { remove: async () => undefined };
  });
  PN.createChannel.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("VITE_API_URL", API);
});
afterEach(() => {
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pushSupported / pushPermission", () => {
  it("web: unsupported, and the plugin is never touched", async () => {
    setNativePlatform(null);
    const push = await load();
    expect(await push.pushSupported()).toBe(false);
    expect(await push.pushPermission()).toBe("unavailable");
    expect(await push.enablePush()).toBe("unavailable");
    expect(PN.checkPermissions).not.toHaveBeenCalled();
    expect(PN.register).not.toHaveBeenCalled();
  });

  it("iOS is supported", async () => {
    setNativePlatform("ios");
    expect(await (await load()).pushSupported()).toBe(true);
  });

  it("Android is supported only in builds with VITE_PUSH_ANDROID=1 (google-services.json present)", async () => {
    setNativePlatform("android");
    expect(await (await load()).pushSupported()).toBe(false);
    vi.stubEnv("VITE_PUSH_ANDROID", "0");
    expect(await (await load()).pushSupported()).toBe(false);
    vi.stubEnv("VITE_PUSH_ANDROID", "1");
    expect(await (await load()).pushSupported()).toBe(true);
  });

  it("Android with the updater: the shell's runtime flag wins over the build flag (D10)", async () => {
    setNativePlatform("android");
    vi.stubEnv("VITE_PUSH_ANDROID", "1");
    updaterInfo.mockResolvedValue({ nativeVersion: "1.4.0", androidPushConfigured: false });
    expect(await (await load()).pushSupported()).toBe(false);
    vi.stubEnv("VITE_PUSH_ANDROID", "0");
    updaterInfo.mockResolvedValue({ nativeVersion: "1.4.0", androidPushConfigured: true });
    const push = await load();
    expect(await push.pushSupported()).toBe(true);
    expect(await push.pushPermission()).toBe("granted");
  });

  it("Android: an updater probe that throws falls back to the build flag", async () => {
    setNativePlatform("android");
    vi.stubEnv("VITE_PUSH_ANDROID", "1");
    updaterInfo.mockRejectedValue(new Error("no plugin"));
    expect(await (await load()).pushSupported()).toBe(true);
  });

  it("web never asks the updater", async () => {
    setNativePlatform(null);
    await (await load()).pushSupported();
    expect(updaterInfo).not.toHaveBeenCalled();
  });

  it("maps the OS permission states", async () => {
    setNativePlatform("ios");
    const push = await load();
    for (const [receive, want] of [
      ["granted", "granted"],
      ["denied", "denied"],
      ["prompt", "prompt"],
      ["prompt-with-rationale", "prompt"],
    ] as const) {
      PN.checkPermissions.mockResolvedValue({ receive });
      expect(await push.pushPermission()).toBe(want);
    }
  });

  it("a plugin that throws reads as unavailable", async () => {
    setNativePlatform("ios");
    const push = await load();
    PN.checkPermissions.mockRejectedValue(new Error("not implemented"));
    expect(await push.pushPermission()).toBe("unavailable");
  });
});

describe("enablePush", () => {
  it("Android without FCM never prompts, registers or calls the API", async () => {
    setNativePlatform("android");
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("unavailable");
    expect(PN.requestPermissions).not.toHaveBeenCalled();
    expect(PN.register).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it("iOS, already granted: registers with APNs and posts the device to the API; no second prompt", async () => {
    setNativePlatform("ios");
    vi.stubEnv("VITE_APP_VERSION", "1.2.3");
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("enabled");
    expect(PN.requestPermissions).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${API}/api/me/push-devices`);
    expect(f.calls[0]?.method).toBe("POST");
    expect(f.calls[0]?.body).toEqual({
      platform: "ios",
      provider: "apns",
      token: TOKEN,
      appVersion: "1.2.3",
    });
    expect(f.calls[0]?.headers.get("X-Tinyglow-Client")).toBe("native");
    expect(f.calls[0]?.headers.get("Authorization")).toBe("Bearer AT");
  });

  it("asks the OS once when permission is not yet decided", async () => {
    setNativePlatform("ios");
    const push = await load();
    PN.checkPermissions.mockResolvedValue({ receive: "prompt" });
    stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("enabled");
    expect(PN.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it("a denied prompt is 'denied' and nothing is registered or sent", async () => {
    setNativePlatform("ios");
    const push = await load();
    PN.checkPermissions.mockResolvedValue({ receive: "prompt" });
    PN.requestPermissions.mockResolvedValue({ receive: "denied" });
    const f = stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("denied");
    expect(PN.register).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it("Android with FCM registers as fcm and creates the notification channel", async () => {
    setNativePlatform("android");
    vi.stubEnv("VITE_PUSH_ANDROID", "1");
    const push = await load();
    const f = stubFetch(() =>
      jsonResponse({ device: { ...device.device, platform: "android" } }, 201),
    );
    expect(await push.enablePush()).toBe("enabled");
    expect(f.calls[0]?.body).toMatchObject({ platform: "android", provider: "fcm", token: TOKEN });
    expect(PN.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: "default" }));
  });

  it("a registration error from the OS is 'failed' and nothing is sent", async () => {
    setNativePlatform("ios");
    const push = await load();
    PN.register.mockImplementation(async () => {
      setTimeout(() => listeners.get("registrationError")?.({ error: "no" }), 0);
    });
    const f = stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });

  it("register() rejecting is 'failed'", async () => {
    setNativePlatform("ios");
    const push = await load();
    PN.register.mockRejectedValue(new Error("boom"));
    stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("failed");
  });

  it("no token within 15 seconds is 'failed'", async () => {
    setNativePlatform("ios");
    const push = await load();
    PN.register.mockImplementation(async () => undefined);
    stubFetch(() => jsonResponse(device, 201));
    vi.useFakeTimers();
    const p = push.enablePush();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await p).toBe("failed");
  });

  it.each([
    ["a 429", 429, { error: "rate_limited", message: "x" }],
    ["a 404", 404, { error: "not_found", message: "x" }],
    ["a 403 (consent)", 403, { error: "consent_required", message: "x" }],
    ["a 500", 500, { error: "internal", message: "x" }],
  ])("%s from the API leaves notifications off ('failed')", async (_n, status, body) => {
    setNativePlatform("ios");
    const push = await load();
    stubFetch(() => jsonResponse(body, status));
    expect(await push.enablePush()).toBe("failed");
  });

  it("offline is 'failed'", async () => {
    setNativePlatform("ios");
    const push = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(await push.enablePush()).toBe("failed");
  });

  it("an invalid app version falls back to 1.0.0", async () => {
    setNativePlatform("ios");
    vi.stubEnv("VITE_APP_VERSION", "not a version!");
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    await push.enablePush();
    expect((f.calls[0]?.body as { appVersion?: string } | undefined)?.appVersion).toBe("1.0.0");
  });

  it("the shell's own version (updater info().nativeVersion) is sent, not the web build's (D10)", async () => {
    setNativePlatform("ios");
    vi.stubEnv("VITE_APP_VERSION", "1.2.3");
    updaterInfo.mockResolvedValue({ nativeVersion: "2.0.1", androidPushConfigured: false });
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    expect(await push.enablePush()).toBe("enabled");
    expect((f.calls[0]?.body as { appVersion?: string } | undefined)?.appVersion).toBe("2.0.1");
  });

  it("an invalid native version falls back to VITE_APP_VERSION", async () => {
    setNativePlatform("ios");
    vi.stubEnv("VITE_APP_VERSION", "1.2.3");
    updaterInfo.mockResolvedValue({ nativeVersion: "bad version!", androidPushConfigured: false });
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    await push.enablePush();
    expect((f.calls[0]?.body as { appVersion?: string } | undefined)?.appVersion).toBe("1.2.3");
  });

  it("never logs the device token or stores it", async () => {
    setNativePlatform("ios");
    const push = await load();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    stubFetch(() => jsonResponse(device, 201));
    await push.enablePush();
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("registers its listeners once across repeated calls", async () => {
    setNativePlatform("ios");
    const push = await load();
    stubFetch(() => jsonResponse(device, 201));
    await push.enablePush();
    await push.enablePush();
    expect(PN.addListener.mock.calls.filter((c) => c[0] === "registration")).toHaveLength(1);
  });
});

describe("refreshPushRegistration", () => {
  it("re-registers silently when permission was already granted", async () => {
    setNativePlatform("ios");
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    await push.refreshPushRegistration();
    expect(f.calls).toHaveLength(1);
    expect(PN.requestPermissions).not.toHaveBeenCalled();
  });

  it.each(["prompt", "denied"])(
    "never prompts or registers when permission is %s",
    async (receive) => {
      setNativePlatform("ios");
      const push = await load();
      PN.checkPermissions.mockResolvedValue({ receive });
      const f = stubFetch(() => jsonResponse(device, 201));
      await push.refreshPushRegistration();
      expect(PN.requestPermissions).not.toHaveBeenCalled();
      expect(PN.register).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(0);
    },
  );

  it("does nothing on the web", async () => {
    setNativePlatform(null);
    const push = await load();
    const f = stubFetch(() => jsonResponse(device, 201));
    await push.refreshPushRegistration();
    expect(f.calls).toHaveLength(0);
  });
});

describe("unregisterCurrentPushDevice", () => {
  it("DELETEs /me/push-devices/current and swallows failures", async () => {
    setNativePlatform("ios");
    const push = await load();
    const f = stubFetch(() => jsonResponse({ error: "internal", message: "x" }, 500));
    await expect(push.unregisterCurrentPushDevice()).resolves.toBeUndefined();
    expect(f.calls[0]?.method).toBe("DELETE");
    expect(f.calls[0]?.url).toBe(`${API}/api/me/push-devices/current`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(push.unregisterCurrentPushDevice()).resolves.toBeUndefined();
  });
});

describe("onPushTap", () => {
  async function armed() {
    setNativePlatform("ios");
    const push = await load();
    const cb = vi.fn();
    const off = push.onPushTap(cb);
    await vi.waitFor(() => expect(listeners.has("pushNotificationActionPerformed")).toBe(true));
    const tap = (data: unknown) =>
      listeners.get("pushNotificationActionPerformed")?.({ notification: { data } });
    return { cb, off, tap };
  }

  it("delivers a photos_analyzed tap (ids only) from the APNs 'll' key", async () => {
    const { cb, tap } = await armed();
    tap({ ll: { kind: "photos_analyzed", babyId: BABY } });
    expect(cb).toHaveBeenCalledWith({ kind: "photos_analyzed", babyId: BABY });
  });

  it("delivers a share_viewed tap from FCM's flat data", async () => {
    const { cb, tap } = await armed();
    tap({ kind: "share_viewed", babyId: BABY, shareLinkId: LINK });
    expect(cb).toHaveBeenCalledWith({ kind: "share_viewed", babyId: BABY, shareLinkId: LINK });
  });

  it.each([
    ["extra keys (a name)", { ll: { kind: "photos_analyzed", babyId: BABY, name: "Mia" } }],
    ["a non-uuid baby id", { ll: { kind: "photos_analyzed", babyId: "mia" } }],
    ["an unknown kind", { ll: { kind: "chat", babyId: BABY } }],
    ["share_viewed without a link id", { ll: { kind: "share_viewed", babyId: BABY } }],
    ["no data", undefined],
    ["a string", "photos_analyzed"],
  ])("ignores a tap with %s", async (_n, data) => {
    const { cb, tap } = await armed();
    tap(data);
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", async () => {
    const { cb, off, tap } = await armed();
    off();
    tap({ ll: { kind: "photos_analyzed", babyId: BABY } });
    expect(cb).not.toHaveBeenCalled();
  });

  it("on the web it never touches the plugin", async () => {
    setNativePlatform(null);
    const push = await load();
    push.onPushTap(vi.fn());
    await Promise.resolve();
    expect(PN.addListener).not.toHaveBeenCalled();
  });
});

describe("Capacitor plugin Proxy (thenable trap) and the permission timeout", () => {
  it("pushPermission and enablePush settle even though the plugin answers `then` and never settles it", async () => {
    setNativePlatform("ios");
    const push = await load();
    stubFetch(() => jsonResponse(device, 201));
    await expect(push.pushPermission()).resolves.toBe("granted");
    await expect(push.enablePush()).resolves.toBe("enabled");
  });

  it("a checkPermissions() that never resolves gives 'unavailable' after 5 s", async () => {
    vi.useFakeTimers();
    setNativePlatform("ios");
    PN.checkPermissions.mockReset().mockReturnValue(new Promise(() => undefined));
    const push = await load();
    let result: string | undefined;
    void push.pushPermission().then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBe("unavailable");
  });

  it("enablePush reports 'failed' (not a hang) when checkPermissions never resolves", async () => {
    vi.useFakeTimers();
    setNativePlatform("ios");
    PN.checkPermissions.mockReset().mockReturnValue(new Promise(() => undefined));
    const push = await load();
    let result: string | undefined;
    void push.enablePush().then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(result).toBe("failed");
    expect(PN.register).not.toHaveBeenCalled();
  });
});
