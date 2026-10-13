import {
  APP_UPDATE_MANIFEST_JSON_MAX_CHARS,
  type AppUpdateManifest,
  appUpdateManifestSchema,
} from "@tinyglow/shared";
import type { FastifyBaseLogger } from "fastify";

// The live-update manifest upstream (docs/plans/step-14.md 2.6): the web image's
// `/app-update/manifest.json`, fetched over the Compose network (`APP_UPDATE_SOURCE_URL`).
//
// - 3 s timeout (headers and body), `If-None-Match` with the last ETag, body capped at 1 MiB.
// - A valid manifest is fresh for 60 s; a 304 refreshes it.
// - Transport failures (network error, timeout, 5xx: the web container restarting during a
//   deploy) serve the last good manifest for up to 24 h. A 404, another 4xx or a 200 that is
//   not a valid manifest (the Vite dev server answers `index.html`) drop it at once: the web
//   container is up and says there is no usable bundle, and the old bundle's hashed files are
//   gone with the old image.
// - After a failure the upstream is retried at most every 10 s, so a dead upstream never adds
//   3 s to every check. Concurrent callers share one fetch.
// - Logged once per distinct failure (`{ outcome[, status] }`, "app updates: source
//   unavailable") and once on recovery. Never the URL, the body or a header value.

export type SourceFailure = "unreachable" | "timeout" | "http_error" | "invalid_manifest";

export interface ManifestSourceOptions {
  /** `APP_UPDATE_SOURCE_URL`. Never logged. */
  url: string;
  log: FastifyBaseLogger;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
  /** Clock in ms (tests). */
  now?: () => number;
  /** Freshness of a good manifest (default 60 s). */
  ttlMs?: number;
  /** How long the last good manifest is served while the upstream is unreachable (default 24 h). */
  staleMs?: number;
  /** Least time between two fetches after a failure (default 10 s). */
  retryMs?: number;
  /** Per-fetch timeout, headers and body (default 3 s). */
  timeoutMs?: number;
}

export interface ManifestSource {
  /** The current manifest, or `null` when the upstream has none usable. Never throws. */
  get(): Promise<AppUpdateManifest | null>;
}

export const APP_UPDATE_SOURCE_TTL_MS = 60_000;
export const APP_UPDATE_SOURCE_STALE_MS = 24 * 60 * 60 * 1000;
export const APP_UPDATE_SOURCE_RETRY_MS = 10_000;
export const APP_UPDATE_SOURCE_TIMEOUT_MS = 3_000;
/** Largest manifest body read from the upstream (same cap as `manifestJson`). */
export const APP_UPDATE_SOURCE_MAX_BYTES = APP_UPDATE_MANIFEST_JSON_MAX_CHARS;

interface Good {
  manifest: AppUpdateManifest;
  etag: string | undefined;
  /** Last time the upstream confirmed it (200 or 304). */
  confirmedAt: number;
}

type FetchResult =
  | { kind: "ok"; manifest: AppUpdateManifest; etag: string | undefined }
  | { kind: "not_modified" }
  | { kind: "fail"; failure: SourceFailure; status?: number; transient: boolean };

class BodyTooLarge extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createManifestSource(opts: ManifestSourceOptions): ManifestSource {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? APP_UPDATE_SOURCE_TTL_MS;
  const staleMs = opts.staleMs ?? APP_UPDATE_SOURCE_STALE_MS;
  const retryMs = opts.retryMs ?? APP_UPDATE_SOURCE_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? APP_UPDATE_SOURCE_TIMEOUT_MS;

  let good: Good | null = null;
  /** Last failed attempt (ms) and whether stale serving is allowed after it. */
  let failedAt: number | null = null;
  let failedTransient = false;
  /** Failure last logged (`outcome:status`), so each distinct failure logs once. */
  let loggedFailure: string | null = null;
  let inflight: Promise<void> | null = null;

  async function fetchOnce(): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (good?.etag) headers["if-none-match"] = good.etag;
      let res: Response;
      try {
        res = await doFetch(opts.url, {
          headers,
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        return controller.signal.aborted
          ? { kind: "fail", failure: "timeout", transient: true }
          : { kind: "fail", failure: "unreachable", transient: true };
      }
      if (res.status === 304) {
        await res.body?.cancel().catch(() => {});
        return good
          ? { kind: "not_modified" }
          : { kind: "fail", failure: "http_error", status: 304, transient: false };
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return {
          kind: "fail",
          failure: "http_error",
          status: res.status,
          transient: res.status >= 500 || res.status === 429,
        };
      }
      let text: string;
      try {
        text = await readCapped(res, APP_UPDATE_SOURCE_MAX_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          return { kind: "fail", failure: "invalid_manifest", transient: false };
        }
        return controller.signal.aborted
          ? { kind: "fail", failure: "timeout", transient: true }
          : { kind: "fail", failure: "unreachable", transient: true };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { kind: "fail", failure: "invalid_manifest", transient: false };
      }
      const parsed = appUpdateManifestSchema.safeParse(json);
      if (!parsed.success) return { kind: "fail", failure: "invalid_manifest", transient: false };
      return { kind: "ok", manifest: parsed.data, etag: res.headers.get("etag") ?? undefined };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(): Promise<void> {
    const result = await fetchOnce();
    const t = now();
    if (result.kind === "ok" || result.kind === "not_modified") {
      if (result.kind === "ok") {
        // Same content and build as before: keep the object so the signed envelope stays memoised.
        const same =
          good !== null &&
          good.manifest.version === result.manifest.version &&
          good.manifest.builtAt === result.manifest.builtAt;
        good = {
          manifest: same && good ? good.manifest : result.manifest,
          etag: result.etag,
          confirmedAt: t,
        };
      } else if (good) {
        good.confirmedAt = t;
      }
      failedAt = null;
      if (loggedFailure !== null) {
        opts.log.info({ outcome: "ok" }, "app updates: source available");
        loggedFailure = null;
      }
      return;
    }
    failedAt = t;
    failedTransient = result.transient;
    if (!result.transient) good = null;
    const key = `${result.failure}:${result.status ?? ""}`;
    if (key !== loggedFailure) {
      loggedFailure = key;
      opts.log.warn(
        {
          outcome: result.failure,
          ...(result.status !== undefined ? { status: result.status } : {}),
          stale: result.transient && good !== null && t - good.confirmedAt <= staleMs,
        },
        "app updates: source unavailable",
      );
    }
  }

  function current(t: number): AppUpdateManifest | null {
    if (!good) return null;
    if (failedAt === null) return good.manifest;
    return failedTransient && t - good.confirmedAt <= staleMs ? good.manifest : null;
  }

  return {
    async get() {
      const t = now();
      const fresh = good !== null && failedAt === null && t - good.confirmedAt < ttlMs;
      const backingOff = failedAt !== null && t - failedAt < retryMs;
      if (fresh || backingOff) return current(t);
      if (!inflight) {
        inflight = refresh()
          .catch(() => {
            // `fetchOnce` maps every expected error; anything else is treated as transient.
            failedAt = now();
            failedTransient = true;
          })
          .finally(() => {
            inflight = null;
          });
      }
      await inflight;
      return current(now());
    },
  };
}
