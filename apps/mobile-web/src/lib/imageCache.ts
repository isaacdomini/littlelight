// Offline viewing of recently opened photos (docs/plans/step-5.md D9): the Cache API holds the
// last 50 opened display images (and the thumbs of the photos around them). Entries are keyed by
// a synthetic request per photo id and kind, never by the signed URL (which expires). Where
// `caches` is unavailable every function is a no-op / miss. Cleared on sign-out.

export type PhotoImageKind = "thumb" | "display";

const CACHE_NAME = "ll-photos-v1";
/** Display images kept (LRU). */
export const MAX_CACHED_DISPLAYS = 50;
/** Thumbs kept: 50 opened photos plus their two neighbours. */
export const MAX_CACHED_THUMBS = MAX_CACHED_DISPLAYS * 3;
// A fixed http(s) origin: the Cache API rejects other schemes (capacitor://, file://).
const SYNTHETIC_ORIGIN = "https://cache.tinyglow.invalid";
const LIMITS: Record<PhotoImageKind, number> = {
  display: MAX_CACHED_DISPLAYS,
  thumb: MAX_CACHED_THUMBS,
};

function cacheAvailable(): boolean {
  return typeof caches !== "undefined";
}

export function photoCacheRequest(photoId: string, kind: PhotoImageKind): Request {
  return new Request(`${SYNTHETIC_ORIGIN}/_cache/photos/${photoId}/${kind}`);
}

async function trim(cache: Cache, kind: PhotoImageKind): Promise<void> {
  const keys = (await cache.keys()).filter((r) => r.url.endsWith(`/${kind}`));
  // keys() is in insertion order; re-inserting on every put keeps this an LRU.
  const excess = keys.length - LIMITS[kind];
  for (let i = 0; i < excess; i += 1) {
    const stale = keys[i];
    if (stale) await cache.delete(stale);
  }
}

/** Fetches `url` and stores the bytes under the photo's synthetic key. Never throws. */
export async function cachePhotoImage(
  photoId: string,
  kind: PhotoImageKind,
  url: string,
): Promise<boolean> {
  if (!cacheAvailable()) return false;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return false;
    const cache = await caches.open(CACHE_NAME);
    const req = photoCacheRequest(photoId, kind);
    await cache.delete(req);
    await cache.put(req, res);
    await trim(cache, kind);
    return true;
  } catch {
    return false;
  }
}

/** An object URL for the cached image, or null. The caller revokes it (`URL.revokeObjectURL`). */
export async function cachedPhotoImageUrl(
  photoId: string,
  kind: PhotoImageKind,
): Promise<string | null> {
  if (!cacheAvailable()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(photoCacheRequest(photoId, kind));
    if (!res) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

/** True when a display image of the photo is cached (it counts as "recently opened"). */
export async function hasCachedDisplay(photoId: string): Promise<boolean> {
  if (!cacheAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(photoCacheRequest(photoId, "display"))) !== undefined;
  } catch {
    return false;
  }
}

/** Drops every cached image (sign-out, account deletion). */
export async function clearImageCache(): Promise<void> {
  if (!cacheAvailable()) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // best effort
  }
}
