import type { GoogleClient, RefreshedAccess } from "./client";

// Per-user cache of Google access tokens in api memory (docs/plans/step-10.md 2.6; step 10 review
// should-fix 3). A picking batch is polled every few seconds; without the cache each due poll
// decrypted the refresh token, ran a refresh grant at Google and wrote `last_used_at`.
//
// - Keyed by user id, one cache per Google client instance (so per app, and tokens of the fake
//   never meet the live provider). Tokens are kept until 60 s before Google's `expires_in`.
// - Memory only: never persisted, logged, returned to a client or put in an error.
// - One refresh per user at a time: concurrent callers share the in-flight mint.
// - `evict(uid)` (disconnect, reconnect, `invalid_grant`, account deletion) also marks an
//   in-flight mint stale so its result is never stored; `evict(uid, token)` (a 401 from Google)
//   drops that token only, keeping a newer one another request already minted.
// - Bounded: at most `ACCESS_TOKEN_CACHE_MAX_ENTRIES` users; expired entries are pruned first,
//   then the oldest entry.

/** A cached token is dropped this many seconds before Google says it expires. */
export const ACCESS_TOKEN_EARLY_EXPIRY_SEC = 60;
/** Most users with a cached token. */
export const ACCESS_TOKEN_CACHE_MAX_ENTRIES = 10_000;

interface Entry {
  accessToken: string;
  /** Epoch ms after which the entry is not used. */
  usableUntil: number;
}

interface Flight {
  promise: Promise<string>;
  stale: boolean;
}

export interface CachedAccessToken {
  /** In memory only: never log, store or return it. */
  accessToken: string;
  /** True when it came from the cache (or a mint another request had already started). */
  cached: boolean;
}

export class GoogleAccessTokenCache {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Flight>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(opts: { now?: () => number; maxEntries?: number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#maxEntries = opts.maxEntries ?? ACCESS_TOKEN_CACHE_MAX_ENTRIES;
  }

  /** Users with a cached entry (expired ones included until pruned). */
  get size(): number {
    return this.#entries.size;
  }

  /** The cached, still usable token of `uid`, if any. */
  peek(uid: string): string | undefined {
    const entry = this.#entries.get(uid);
    if (!entry) return undefined;
    if (this.#now() >= entry.usableUntil) {
      this.#entries.delete(uid);
      return undefined;
    }
    return entry.accessToken;
  }

  /**
   * The cached token of `uid`, else one from `mint` (stored when it lives longer than the early
   * expiry margin). `fresh` skips the cache and any in-flight mint. Errors of `mint` reach every
   * caller sharing it and leave nothing cached.
   */
  async get(
    uid: string,
    mint: () => Promise<RefreshedAccess>,
    opts: { fresh?: boolean } = {},
  ): Promise<CachedAccessToken> {
    if (!opts.fresh) {
      const hit = this.peek(uid);
      if (hit !== undefined) return { accessToken: hit, cached: true };
      const flight = this.#flights.get(uid);
      if (flight && !flight.stale) return { accessToken: await flight.promise, cached: true };
    }
    const flight: Flight = { promise: Promise.resolve(""), stale: false };
    flight.promise = (async () => {
      try {
        const minted = await mint();
        if (!flight.stale && this.#flights.get(uid) === flight) {
          this.#store(uid, minted);
        }
        return minted.accessToken;
      } finally {
        if (this.#flights.get(uid) === flight) this.#flights.delete(uid);
      }
    })();
    this.#flights.set(uid, flight);
    return { accessToken: await flight.promise, cached: false };
  }

  /**
   * Drop `uid`'s token. With `accessToken`, only when it is the cached one (a 401 on that token);
   * without, also mark an in-flight mint stale (the grant changed or ended).
   */
  evict(uid: string, accessToken?: string): void {
    if (accessToken !== undefined) {
      if (this.#entries.get(uid)?.accessToken === accessToken) this.#entries.delete(uid);
      return;
    }
    this.#entries.delete(uid);
    const flight = this.#flights.get(uid);
    if (flight) {
      flight.stale = true;
      this.#flights.delete(uid);
    }
  }

  /** Drop everything (tests, shutdown). */
  clear(): void {
    this.#entries.clear();
    for (const flight of this.#flights.values()) flight.stale = true;
    this.#flights.clear();
  }

  #store(uid: string, minted: RefreshedAccess): void {
    const lifetimeMs = (minted.expiresInSec - ACCESS_TOKEN_EARLY_EXPIRY_SEC) * 1000;
    if (!(lifetimeMs > 0)) {
      this.#entries.delete(uid);
      return;
    }
    this.#entries.delete(uid); // re-insert at the end (oldest-first eviction order)
    if (this.#entries.size >= this.#maxEntries) this.#prune();
    this.#entries.set(uid, {
      accessToken: minted.accessToken,
      usableUntil: this.#now() + lifetimeMs,
    });
  }

  #prune(): void {
    const now = this.#now();
    for (const [uid, entry] of this.#entries) {
      if (now >= entry.usableUntil) this.#entries.delete(uid);
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

const caches = new WeakMap<GoogleClient, GoogleAccessTokenCache>();

/** The access-token cache of a Google client instance (created on first use). */
export function accessTokenCacheOf(google: GoogleClient): GoogleAccessTokenCache {
  let cache = caches.get(google);
  if (!cache) {
    cache = new GoogleAccessTokenCache();
    caches.set(google, cache);
  }
  return cache;
}
