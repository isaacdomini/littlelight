import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../testing/native";
import { ApiError } from "./api";
import {
  cancelImport,
  createImport,
  discardWindow,
  disconnectGoogle,
  googleConnectionKey,
  importErrorKey,
  importsKey,
  isActiveBatch,
  onReturnToApp,
  openExternal,
  preopenWindow,
  requestConnectUrl,
  useGoogleConnection,
  useImportBatch,
  useRecentImports,
  useRefreshOnReturn,
} from "./googleImport";

// Google Photos import client (docs/plans/step-10.md 2.5, D14, D15): connection state, polling
// cadence, native uses the system browser (never the WebView), web uses a pre-opened tab, return
// handling, friendly errors. No consent or picker URL is stored.

const browser = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
}));
const app = vi.hoisted(() => ({
  addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
}));
vi.mock("@capacitor/browser", () => ({ Browser: browser }));
vi.mock("@capacitor/app", () => ({ App: app }));

const BABY = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const batch = (over: Record<string, unknown> = {}) => ({
  id: BATCH,
  babyId: BABY,
  kind: "google_picker",
  status: "picking",
  error: null,
  requestedBy: USER,
  requestedByName: "Mom",
  isMine: true,
  itemsTotal: null,
  itemsImported: 0,
  itemsDuplicate: 0,
  itemsFailed: 0,
  itemsSkipped: 0,
  pollIntervalSec: 5,
  pickerExpiresAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...over,
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function intervalOf(client: QueryClient, key: readonly unknown[]): number | false | undefined {
  const q = client.getQueryCache().find({ queryKey: key });
  const opt = q?.observers[0]?.options.refetchInterval;
  return typeof opt === "function" ? (opt as (query: unknown) => number | false)(q) : opt;
}

beforeEach(() => {
  browser.open.mockClear();
  browser.addListener.mockClear();
  app.addListener.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setNativePlatform(null);
});

describe("useGoogleConnection", () => {
  it("reads the connection", async () => {
    stubFetch(() =>
      jsonResponse({
        available: true,
        connected: true,
        connectedAt: "2026-10-10T10:00:00.000Z",
        needsReconnect: false,
      }),
    );
    const { result } = renderHook(() => useGoogleConnection(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.data?.connected).toBe(true));
  });

  it("a 404 feature_unavailable reads as 'not available' (the UI hides the feature)", async () => {
    stubFetch(() => jsonResponse({ error: "feature_unavailable", message: "off" }, 404));
    const { result } = renderHook(() => useGoogleConnection(), { wrapper: wrapper(newClient()) });
    await waitFor(() =>
      expect(result.current.data).toEqual({
        available: false,
        connected: false,
        connectedAt: null,
        needsReconnect: false,
      }),
    );
  });

  it("other errors stay errors (no silent 'unavailable')", async () => {
    stubFetch(() => jsonResponse({ error: "internal", message: "x" }, 500));
    const { result } = renderHook(() => useGoogleConnection(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("does not fetch while disabled; rejects an unexpected field (strict schema)", async () => {
    const { fn } = stubFetch(() =>
      jsonResponse({
        available: true,
        connected: false,
        connectedAt: null,
        needsReconnect: false,
        token: "x",
      }),
    );
    renderHook(() => useGoogleConnection(false), { wrapper: wrapper(newClient()) });
    expect(fn).not.toHaveBeenCalled();
    const { result } = renderHook(() => useGoogleConnection(true), {
      wrapper: wrapper(newClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("polling cadence", () => {
  it("isActiveBatch is picking/queued/running only", () => {
    for (const [status, expected] of [
      ["picking", true],
      ["queued", true],
      ["running", true],
      ["done", false],
      ["failed", false],
      ["cancelled", false],
      ["expired", false],
    ] as const)
      expect(isActiveBatch({ status }), status).toBe(expected);
  });

  it("useImportBatch polls at the server's interval (never faster than 3 s) while active and stops when finished", async () => {
    let b = batch({ pollIntervalSec: 5 });
    stubFetch(() => jsonResponse({ batch: b }));
    const client = newClient();
    const { result } = renderHook(() => useImportBatch(BATCH), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.status).toBe("picking"));
    expect(intervalOf(client, ["imports", BATCH])).toBe(5000);
    b = batch({ pollIntervalSec: 1 });
    await client.refetchQueries({ queryKey: ["imports", BATCH] });
    expect(intervalOf(client, ["imports", BATCH])).toBe(3000);
    b = batch({ status: "done" });
    await client.refetchQueries({ queryKey: ["imports", BATCH] });
    await waitFor(() => expect(result.current.data?.status).toBe("done"));
    expect(intervalOf(client, ["imports", BATCH])).toBe(false);
  });

  it("useImportBatch does nothing without an id", () => {
    const { fn } = stubFetch(() => jsonResponse({ batch: batch() }));
    renderHook(() => useImportBatch(null), { wrapper: wrapper(newClient()) });
    expect(fn).not.toHaveBeenCalled();
  });

  it("useRecentImports polls only while one of the listed batches is active", async () => {
    let list = [batch({ status: "running", pollIntervalSec: 7 })];
    stubFetch(() => jsonResponse({ batches: list }));
    const client = newClient();
    const { result } = renderHook(() => useRecentImports(BABY), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    const key = [...importsKey(BABY), 5];
    expect(intervalOf(client, key)).toBe(7000);
    list = [batch({ status: "done" })];
    await client.refetchQueries({ queryKey: key });
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe("done"));
    expect(intervalOf(client, key)).toBe(false);
  });

  it("useRecentImports needs a baby", () => {
    const { fn } = stubFetch(() => jsonResponse({ batches: [] }));
    renderHook(() => useRecentImports(undefined), { wrapper: wrapper(newClient()) });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("requests", () => {
  it("createImport POSTs an empty body and returns the picker URL once", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ batch: batch(), pickerUri: "https://photos.google.com/picker/abc" }, 201),
    );
    const res = await createImport(BABY);
    expect(res.pickerUri).toBe("https://photos.google.com/picker/abc");
    expect(calls[0]).toMatchObject({ method: "POST", body: {} });
    expect(new URL(calls[0]?.url ?? "", "http://x").pathname.replace(/^\/api/, "")).toBe(
      `/babies/${BABY}/imports/google`,
    );
  });

  it("cancelImport and disconnectGoogle use the documented routes", async () => {
    const { calls } = stubFetch((c) =>
      c.method === "DELETE"
        ? jsonResponse(null, 204)
        : jsonResponse({ batch: batch({ status: "cancelled" }) }),
    );
    expect((await cancelImport(BATCH)).status).toBe("cancelled");
    await disconnectGoogle();
    expect(
      calls.map((c) => `${c.method} ${new URL(c.url, "http://x").pathname.replace(/^\/api/, "")}`),
    ).toEqual([`POST /imports/${BATCH}/cancel`, "DELETE /me/import/google/connection"]);
  });

  it("requestConnectUrl says web or native, and where to return", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }),
    );
    expect(await requestConnectUrl("/upload")).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(calls[0]?.body).toEqual({ client: "web", returnTo: "/upload" });
    setNativePlatform("ios");
    await requestConnectUrl("/settings/import");
    expect(calls[1]?.body).toEqual({ client: "native", returnTo: "/settings/import" });
  });
});

describe("opening Google's pages", () => {
  it("web: openExternal points the pre-opened tab at the URL", async () => {
    const pre = {
      closed: false,
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    expect(await openExternal("https://photos.google.com/picker/abc", pre)).toBe(true);
    expect(pre.location.href).toBe("https://photos.google.com/picker/abc");
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("web: without a usable pre-opened tab it falls back to window.open with noopener, and reports a blocked popup", async () => {
    const open = vi
      .spyOn(window, "open")
      .mockReturnValueOnce({} as Window)
      .mockReturnValueOnce(null);
    expect(await openExternal("https://x.test/a", null)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://x.test/a", "_blank", "noopener");
    expect(await openExternal("https://x.test/a", { closed: true } as Window)).toBe(false);
  });

  it("web: preopenWindow opens a blank tab and drops its opener; discardWindow closes it", () => {
    const w = { opener: {}, close: vi.fn() } as unknown as Window & { opener: unknown };
    vi.spyOn(window, "open").mockReturnValue(w);
    expect(preopenWindow()).toBe(w);
    expect(w.opener).toBeNull();
    discardWindow(w);
    expect(w.close).toHaveBeenCalled();
    expect(() => discardWindow(null)).not.toThrow();
  });

  it("native: openExternal uses @capacitor/browser (never the WebView or window.open) and preopenWindow does nothing", async () => {
    setNativePlatform("ios");
    const open = vi.spyOn(window, "open");
    expect(preopenWindow()).toBeNull();
    expect(await openExternal("https://accounts.google.com/x", null)).toBe(true);
    expect(browser.open).toHaveBeenCalledWith({
      url: "https://accounts.google.com/x",
      presentationStyle: "popover",
    });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("returning to the app", () => {
  it("web: focus and becoming visible both call back; cleanup stops it", () => {
    const cb = vi.fn();
    const off = onReturnToApp(cb);
    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("native: also listens for the system browser closing and the app resuming", async () => {
    setNativePlatform("ios");
    const off = onReturnToApp(vi.fn());
    await waitFor(() =>
      expect(browser.addListener).toHaveBeenCalledWith("browserFinished", expect.any(Function)),
    );
    expect(app.addListener).toHaveBeenCalledWith("resume", expect.any(Function));
    off();
  });

  it("useRefreshOnReturn invalidates the connection and the import queries", async () => {
    const client = newClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useRefreshOnReturn(BABY), { wrapper: wrapper(client) });
    window.dispatchEvent(new Event("focus"));
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(googleConnectionKey),
        JSON.stringify(importsKey(BABY)),
        JSON.stringify(["imports"]),
      ]),
    );
  });
});

describe("importErrorKey", () => {
  it.each([
    ["google_not_connected", "google.err.not_connected"],
    ["google_reconnect", "google.err.reconnect"],
    ["import_in_progress", "google.err.in_progress"],
    ["baby_trashed", "google.err.trashed"],
    ["rate_limited", "google.err.rate_limited"],
    ["forbidden", "google.err.forbidden"],
    ["network", "google.err.network"],
    ["internal", "google.err.generic"],
  ])("%s -> %s", (code, key) => {
    expect(importErrorKey(new ApiError(409, code as never, "x"))).toBe(key);
  });
  it("anything that is not an ApiError is generic", () => {
    expect(importErrorKey(new Error("x"))).toBe("google.err.generic");
    expect(importErrorKey(null)).toBe("google.err.generic");
  });
});
