import { describe, expect, it, vi } from "vitest";
import {
  createWorkerGoogleClient,
  type FetchLike,
  GOOGLE_RETRY_MAX_DELAY_MS,
  GoogleError,
  isRetryableStatus,
  isTransientGoogleError,
  retryDelayMs,
} from "./client";

const settings = {
  GOOGLE_IMPORT_PROVIDER: "fake" as const,
  GOOGLE_IMPORT_FAKE_URL: "http://google-fake:8099",
  GOOGLE_IMPORT_FAKE_PUBLIC_URL: "http://localhost:8099",
  GOOGLE_IMPORT_CLIENT_ID: undefined,
  GOOGLE_IMPORT_CLIENT_SECRET: undefined,
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const tokenOk = { access_token: "fake-access-1", expires_in: 3600, token_type: "Bearer" };
const item = {
  id: "G-1",
  createTime: "2026-03-01T09:00:00Z",
  type: "PHOTO",
  mediaFile: { baseUrl: "http://google-fake:8099/media/G-1", mimeType: "image/jpeg" },
};

function make(f: FetchLike, attempts = 3) {
  const sleep = vi.fn(async () => undefined);
  const c = createWorkerGoogleClient(settings, { fetchImpl: f, sleep, attempts });
  if (!c) throw new Error("no client");
  return { c, sleep };
}

describe("retry helpers", () => {
  it("retries 429 and 5xx only", () => {
    for (const s of [429, 500, 502, 503, 599]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404]) expect(isRetryableStatus(s)).toBe(false);
  });

  it("backs off 1 s, 2 s, 4 s and honours Retry-After, capped", () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, null))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(1, "7")).toBe(7000);
    expect(retryDelayMs(1, "99999")).toBe(GOOGLE_RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(1, "soon")).toBe(1000);
    expect(retryDelayMs(30, null)).toBe(GOOGLE_RETRY_MAX_DELAY_MS);
  });

  it("only network and rate_limited errors are worth a job retry", () => {
    expect(isTransientGoogleError(new GoogleError("network"))).toBe(true);
    expect(isTransientGoogleError(new GoogleError("rate_limited"))).toBe(true);
    expect(isTransientGoogleError(new GoogleError("google_reconnect"))).toBe(false);
    expect(isTransientGoogleError(new Error("x"))).toBe(false);
  });
});

describe("createWorkerGoogleClient", () => {
  it("is null for provider none", () => {
    expect(createWorkerGoogleClient({ ...settings, GOOGLE_IMPORT_PROVIDER: "none" })).toBeNull();
  });

  it("refreshes through the token endpoint with a form body", async () => {
    const f = vi.fn<FetchLike>(async () => json(200, tokenOk));
    const { c } = make(f);
    expect(await c.refreshAccessToken("fake-refresh-1")).toBe("fake-access-1");
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("http://google-fake:8099/token");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-1",
    });
    expect(String(url)).not.toContain("fake-refresh");
  });

  it("invalid_grant is google_reconnect (no retry)", async () => {
    const f = vi.fn<FetchLike>(async () => json(400, { error: "invalid_grant" }));
    const { c } = make(f);
    await expect(c.refreshAccessToken("r")).rejects.toMatchObject({ category: "google_reconnect" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 then succeeds, sleeping per backoff", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, tokenOk));
    const { c, sleep } = make(f);
    expect(await c.refreshAccessToken("r")).toBe("fake-access-1");
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("a persistent 429 surfaces rate_limited after the attempts; Retry-After is used", async () => {
    const f = vi.fn<FetchLike>(async () => json(429, {}, { "retry-after": "2" }));
    const { c, sleep } = make(f);
    await expect(c.listMediaItems("t", "s")).rejects.toMatchObject({ category: "rate_limited" });
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
  });

  it("transport errors become network without the cause", async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new Error(
        "ECONNREFUSED http://google-fake:8099/v1/mediaItems?sessionId=fake-session-1",
      );
    });
    const { c } = make(f, 2);
    const err = await c.listMediaItems("t", "fake-session-1").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect(err.category).toBe("network");
    expect(err.message).not.toContain("fake-session");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("lists with pageSize 100 and a page token, bearer on the header only", async () => {
    const f = vi.fn<FetchLike>(async () => json(200, { mediaItems: [item], nextPageToken: "n" }));
    const { c } = make(f);
    const page = await c.listMediaItems("fake-access-1", "fake-session-1", "tok");
    expect(page.mediaItems).toHaveLength(1);
    expect(page.nextPageToken).toBe("n");
    const [url, init] = f.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.pathname).toBe("/v1/mediaItems");
    expect(u.searchParams.get("pageSize")).toBe("100");
    expect(u.searchParams.get("pageToken")).toBe("tok");
    expect(u.search).not.toContain("fake-access");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer fake-access-1",
    );
    expect(init?.redirect).toBe("manual");
  });

  it("a schema mismatch is internal; 4xx is google_denied; 404 not_found (none retried)", async () => {
    expect(
      await make(async () => json(200, { mediaItems: [{ id: 1 }] }))
        .c.listMediaItems("t", "s")
        .catch((e) => e.category),
    ).toBe("internal");
    expect(
      await make(async () => json(403, {}))
        .c.listMediaItems("t", "s")
        .catch((e) => e.category),
    ).toBe("google_denied");
    expect(
      await make(async () => json(404, {}))
        .c.listMediaItems("t", "s")
        .catch((e) => e.category),
    ).toBe("not_found");
  });

  it("deleteSession is best effort and never throws", async () => {
    expect(
      await make(async () => new Response(null, { status: 200 })).c.deleteSession("t", "s"),
    ).toBe(true);
    expect(
      await make(async () => new Response(null, { status: 404 })).c.deleteSession("t", "s"),
    ).toBe(true);
    expect(
      await make(async () => new Response(null, { status: 500 })).c.deleteSession("t", "s"),
    ).toBe(false);
    expect(
      await make(async () => {
        throw new Error("x");
      }).c.deleteSession("t", "s"),
    ).toBe(false);
  });
});
