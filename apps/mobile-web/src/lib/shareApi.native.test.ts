import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ERROR, jsonResponse, setNativePlatform, stubFetch } from "../testing/native";

// Viewer client on native (docs/plans/step-9.md 2.7, 2.15): the bearer viewer token lives in
// memory only, no cookies, and a lost session is re-exchanged exactly once.

const API = "https://api.example.test";
const TOKEN = "T".repeat(22);
const PASSCODE = "739104";
const album = {
  linkName: "Grandparents",
  babyName: "Mia",
  babyNickname: null,
  allowDownload: false,
  expiresAt: "2026-10-10T10:00:00.000Z",
  photoCount: 1,
  hiddenCount: 0,
};
const session = (viewerToken?: string) => ({ album, ...(viewerToken ? { viewerToken } : {}) });
const photos = { photos: [], nextCursor: null };

async function load() {
  vi.resetModules();
  return import("./shareApi");
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", API);
});
afterEach(() => {
  setNativePlatform(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("native viewer session", () => {
  it("exchanges the link token, keeps the viewer token in memory and sends it as a bearer", async () => {
    setNativePlatform("ios");
    const share = await load();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const f = stubFetch((c) =>
      c.url.endsWith("/share/session") ? jsonResponse(session("VT-1")) : jsonResponse(photos),
    );
    await share.openShareSession(TOKEN);
    await share.fetchSharePhotos();
    expect(f.calls[0]?.url).toBe(`${API}/api/share/session`);
    expect(f.calls[0]?.body).toEqual({ token: TOKEN });
    expect(f.calls[0]?.headers.has("Authorization")).toBe(false);
    expect(f.calls[1]?.url).toContain(`${API}/api/share/photos?`);
    expect(f.calls[1]?.headers.get("Authorization")).toBe("Bearer VT-1");
    expect(f.calls[1]?.headers.get("X-Littlelight-Client")).toBe("native");
    expect(f.calls[1]?.credentials).not.toBe("include");
    expect(f.calls[1]?.referrerPolicy).toBe("no-referrer");
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("sends the passcode in the body only when given", async () => {
    setNativePlatform("ios");
    const share = await load();
    const f = stubFetch(() => jsonResponse(session("VT")));
    await share.openShareSession(TOKEN, PASSCODE);
    expect(f.calls[0]?.body).toEqual({ token: TOKEN, passcode: PASSCODE });
  });

  it("re-exchanges ONCE on 410 and retries the request with the new viewer token", async () => {
    setNativePlatform("ios");
    const share = await load();
    let exchanges = 0;
    const f = stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        return jsonResponse(session(`VT-${exchanges}`));
      }
      return c.headers.get("Authorization") === "Bearer VT-2"
        ? jsonResponse(photos)
        : jsonResponse(APP_ERROR("share_link_expired"), 410);
    });
    await share.openShareSession(TOKEN, PASSCODE);
    await expect(share.fetchSharePhotos()).resolves.toEqual(photos);
    expect(exchanges).toBe(2);
    const second = f.calls.filter((c) => c.url.endsWith("/share/session"))[1];
    expect(second?.body).toEqual({ token: TOKEN, passcode: PASSCODE });
  });

  it("re-exchanges on 401 as well", async () => {
    setNativePlatform("android");
    const share = await load();
    let exchanges = 0;
    stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        return jsonResponse(session(`VT-${exchanges}`));
      }
      return c.headers.get("Authorization") === "Bearer VT-2"
        ? jsonResponse(photos)
        : jsonResponse(APP_ERROR("unauthorized"), 401);
    });
    await share.openShareSession(TOKEN);
    await expect(share.fetchSharePhotos()).resolves.toEqual(photos);
    expect(exchanges).toBe(2);
  });

  it("gives up after that one retry: a link that is really expired surfaces as share_link_expired, no loop", async () => {
    setNativePlatform("ios");
    const share = await load();
    let exchanges = 0;
    const f = stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        // the first exchange works; the re-exchange finds the link expired
        return exchanges === 1
          ? jsonResponse(session("VT-1"))
          : jsonResponse(APP_ERROR("share_link_expired"), 410);
      }
      return jsonResponse(APP_ERROR("share_link_expired"), 410);
    });
    await share.openShareSession(TOKEN);
    await expect(share.fetchSharePhotos()).rejects.toMatchObject({
      status: 410,
      code: "share_link_expired",
    });
    expect(exchanges).toBe(2);
    expect(f.calls.filter((c) => c.url.includes("/share/photos"))).toHaveLength(1);
  });

  it("a request that still fails after a successful re-exchange does not trigger a third exchange", async () => {
    setNativePlatform("ios");
    const share = await load();
    let exchanges = 0;
    stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        return jsonResponse(session(`VT-${exchanges}`));
      }
      return jsonResponse(APP_ERROR("share_link_expired"), 410);
    });
    await share.openShareSession(TOKEN);
    await expect(share.fetchSharePhotos()).rejects.toMatchObject({ status: 410 });
    expect(exchanges).toBe(2);
  });

  it("other errors (404, 429) are not retried", async () => {
    setNativePlatform("ios");
    const share = await load();
    let exchanges = 0;
    stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        return jsonResponse(session("VT"));
      }
      return jsonResponse(APP_ERROR("not_found"), 404);
    });
    await share.openShareSession(TOKEN);
    await expect(share.fetchSharePhotos()).rejects.toMatchObject({ status: 404 });
    expect(exchanges).toBe(1);
  });

  it("a wrong passcode on the exchange itself is not re-exchanged", async () => {
    setNativePlatform("ios");
    const share = await load();
    const f = stubFetch(() => jsonResponse(APP_ERROR("passcode_invalid"), 401));
    await expect(share.openShareSession(TOKEN, "000000")).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(1);
  });

  it("clearViewerSession forgets the token and the stored exchange", async () => {
    setNativePlatform("ios");
    const share = await load();
    let exchanges = 0;
    const f = stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        return jsonResponse(session("VT-1"));
      }
      return jsonResponse(APP_ERROR("share_link_expired"), 410);
    });
    await share.openShareSession(TOKEN);
    share.clearViewerSession();
    await expect(share.fetchSharePhotos()).rejects.toMatchObject({ status: 410 });
    expect(exchanges).toBe(1);
    expect(f.calls.at(-1)?.headers.has("Authorization")).toBe(false);
  });

  it("native with no viewer token in the body sends no bearer", async () => {
    setNativePlatform("ios");
    const share = await load();
    const f = stubFetch((c) =>
      c.url.endsWith("/share/session") ? jsonResponse(session()) : jsonResponse(photos),
    );
    await share.openShareSession(TOKEN);
    await share.fetchSharePhotos();
    expect(f.calls[1]?.headers.has("Authorization")).toBe(false);
  });
});

describe("web viewer (control)", () => {
  it("uses the cookie: relative URL, web header, no bearer, no re-exchange on 410", async () => {
    setNativePlatform(null);
    const share = await load();
    let exchanges = 0;
    const f = stubFetch((c) => {
      if (c.url.endsWith("/share/session")) {
        exchanges += 1;
        return jsonResponse(session("SHOULD-BE-IGNORED"));
      }
      return jsonResponse(APP_ERROR("share_link_expired"), 410);
    });
    await share.openShareSession(TOKEN);
    await expect(share.fetchSharePhotos()).rejects.toMatchObject({ status: 410 });
    expect(exchanges).toBe(1);
    expect(f.calls[0]?.url).toBe("/api/share/session");
    expect(f.calls[1]?.headers.has("Authorization")).toBe(false);
    expect(f.calls[1]?.headers.get("X-Littlelight-Client")).toBe("web");
    expect(f.calls[1]?.credentials).toBe("same-origin");
  });
});
