import { describe, expect, it, vi } from "vitest";
import type { RefreshedAccess } from "./client";
import {
  ACCESS_TOKEN_EARLY_EXPIRY_SEC,
  accessTokenCacheOf,
  GoogleAccessTokenCache,
} from "./token-cache";

const minted = (accessToken: string, expiresInSec = 3600): RefreshedAccess => ({
  accessToken,
  expiresInSec,
});

describe("GoogleAccessTokenCache", () => {
  it("reuses a minted token until 60 s before it expires", async () => {
    let now = 1_000_000;
    const cache = new GoogleAccessTokenCache({ now: () => now });
    const mint = vi.fn(async () => minted("t1", 3600));
    expect(await cache.get("u", mint)).toEqual({ accessToken: "t1", cached: false });
    expect(await cache.get("u", mint)).toEqual({ accessToken: "t1", cached: true });
    now += (3600 - ACCESS_TOKEN_EARLY_EXPIRY_SEC - 1) * 1000;
    expect((await cache.get("u", mint)).cached).toBe(true);
    now += 2000;
    mint.mockResolvedValueOnce(minted("t2"));
    expect(await cache.get("u", mint)).toEqual({ accessToken: "t2", cached: false });
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("does not cache a token that lives 60 s or less", async () => {
    const cache = new GoogleAccessTokenCache();
    const mint = vi.fn(async () => minted("short", 60));
    await cache.get("u", mint);
    await cache.get("u", mint);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("keeps users apart", async () => {
    const cache = new GoogleAccessTokenCache();
    await cache.get("a", async () => minted("ta"));
    expect((await cache.get("b", async () => minted("tb"))).accessToken).toBe("tb");
    expect(cache.peek("a")).toBe("ta");
  });

  it("concurrent callers share one in-flight mint", async () => {
    const cache = new GoogleAccessTokenCache();
    let release: (v: RefreshedAccess) => void = () => undefined;
    const mint = vi.fn(() => new Promise<RefreshedAccess>((r) => (release = r)));
    const calls = [cache.get("u", mint), cache.get("u", mint), cache.get("u", mint)];
    await Promise.resolve();
    release(minted("shared"));
    const results = await Promise.all(calls);
    expect(results.map((r) => r.accessToken)).toEqual(["shared", "shared", "shared"]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("a failed mint reaches every sharer and caches nothing", async () => {
    const cache = new GoogleAccessTokenCache();
    let fail: (e: Error) => void = () => undefined;
    const mint = vi.fn(() => new Promise<RefreshedAccess>((_, rej) => (fail = rej)));
    const a = cache.get("u", mint);
    const b = cache.get("u", mint);
    const settled = Promise.allSettled([a, b]);
    await Promise.resolve();
    fail(new Error("boom"));
    expect((await settled).map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(cache.size).toBe(0);
    expect((await cache.get("u", async () => minted("ok"))).cached).toBe(false);
  });

  it("evict(uid) drops the entry and makes an in-flight mint stale (never stored)", async () => {
    const cache = new GoogleAccessTokenCache();
    await cache.get("u", async () => minted("t1"));
    cache.evict("u");
    expect(cache.peek("u")).toBeUndefined();

    let release: (v: RefreshedAccess) => void = () => undefined;
    const pending = cache.get("u", () => new Promise<RefreshedAccess>((r) => (release = r)));
    cache.evict("u");
    release(minted("stale"));
    expect((await pending).accessToken).toBe("stale"); // the caller still gets its own result
    expect(cache.peek("u")).toBeUndefined();
    // and the next caller mints anew rather than joining the stale flight
    expect((await cache.get("u", async () => minted("new"))).accessToken).toBe("new");
  });

  it("evict(uid, token) drops only that token, keeping a newer one", async () => {
    const cache = new GoogleAccessTokenCache();
    await cache.get("u", async () => minted("t2"));
    cache.evict("u", "t1");
    expect(cache.peek("u")).toBe("t2");
    cache.evict("u", "t2");
    expect(cache.peek("u")).toBeUndefined();
  });

  it("fresh skips the cache and replaces the entry", async () => {
    const cache = new GoogleAccessTokenCache();
    await cache.get("u", async () => minted("t1"));
    const r = await cache.get("u", async () => minted("t2"), { fresh: true });
    expect(r).toEqual({ accessToken: "t2", cached: false });
    expect(cache.peek("u")).toBe("t2");
  });

  it("is bounded: expired entries go first, then the oldest", async () => {
    let now = 0;
    const cache = new GoogleAccessTokenCache({ now: () => now, maxEntries: 2 });
    await cache.get("a", async () => minted("ta", 200));
    now += 1000;
    await cache.get("b", async () => minted("tb", 3600));
    await cache.get("c", async () => minted("tc", 3600)); // a expired, pruned
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBe("tb");
    await cache.get("d", async () => minted("td", 3600)); // none expired: oldest (b) goes
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("c")).toBe("tc");
    expect(cache.peek("d")).toBe("td");
    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it("clear() empties it", async () => {
    const cache = new GoogleAccessTokenCache();
    await cache.get("u", async () => minted("t"));
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("accessTokenCacheOf gives one cache per client instance", () => {
    const g1 = {} as never;
    const g2 = {} as never;
    expect(accessTokenCacheOf(g1)).toBe(accessTokenCacheOf(g1));
    expect(accessTokenCacheOf(g1)).not.toBe(accessTokenCacheOf(g2));
  });
});
