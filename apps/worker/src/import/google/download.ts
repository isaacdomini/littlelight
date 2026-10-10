import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type GoogleMediaAllowList,
  IMPORT_MEDIA_MAX_REDIRECTS,
  mediaDownloadUrl,
  parseAllowedMediaUrl,
  resolveMediaRedirect,
} from "@littlelight/shared";
import {
  defaultSleep,
  type FetchLike,
  GOOGLE_CALL_ATTEMPTS,
  isRetryableStatus,
  retryDelayMs,
  type SleepFn,
} from "./client";

// Guarded download of one picked original (docs/plans/step-10.md 2.7 step 5, D6, R5, R6).
//
// - SSRF guard: the `baseUrl=d` download URL must pass `parseAllowedMediaUrl` (https + host
//   suffix allow-list; in `fake` mode the fake's exact origin) and the worker fetches the `href`
//   the guard returned (the exact string that was checked). `redirect: "manual"`: a 3xx is
//   followed only to the same host and only when `resolveMediaRedirect` allows the target, at most
//   `IMPORT_MEDIA_MAX_REDIRECTS` hops. A disallowed URL is never contacted.
// - Size cap before and during the download: a `Content-Length` above the cap aborts before any
//   body byte is read; counted bytes above the cap abort the stream.
// - The body is streamed to `<tmp>/ll-import/<itemId>` (mode 0600) while hashing (SHA-256) and
//   counting; the first bytes are kept for magic-byte sniffing. Production `/tmp` is a 1 GiB tmpfs
//   (≤ IMPORT_CONCURRENCY × 100 MiB in flight).
// - 429 / 5xx / connection errors are retried a bounded number of times (`Retry-After` honoured,
//   capped); a 401 asks the caller for a fresh access token once.
// - Never logged: the URL, the token, the file name, the bytes. Errors carry a category only.

/** Headers must arrive, and the body must make progress, within this many ms. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** Hard bound on one download attempt (a 100 MiB original over a slow link). */
export const DOWNLOAD_TOTAL_TIMEOUT_MS = 15 * 60_000;
/** Bytes kept from the start of the body for `sniffPhotoMime` (file-type reads ≤ 4100). */
export const SNIFF_HEAD_BYTES = 4100;
/** Staging directory name under the OS temp dir. */
export const IMPORT_TMP_DIRNAME = "ll-import";

/** The staging directory (`os.tmpdir()/ll-import`). */
export function importTmpDir(base: string = os.tmpdir()): string {
  return path.join(base, IMPORT_TMP_DIRNAME);
}

/**
 * - `disallowed_url`: the URL (or a redirect target) failed the guard; never contacted.
 * - `too_many_redirects`: more than `IMPORT_MEDIA_MAX_REDIRECTS` hops.
 * - `file_too_large`: `Content-Length` or counted bytes above the cap.
 * - `http`: a non-retryable 4xx (or a retryable status after every attempt).
 * - `network`: connection error, timeout, truncated body after every attempt.
 * - `unauthorized`: 401 even with a fresh token.
 */
export type DownloadErrorCategory =
  | "disallowed_url"
  | "too_many_redirects"
  | "file_too_large"
  | "http"
  | "network"
  | "unauthorized";

/** Category-only error (no URL, token or body). */
export class DownloadError extends Error {
  readonly category: DownloadErrorCategory;
  readonly status: number | undefined;
  constructor(category: DownloadErrorCategory, status?: number) {
    super(`download failed: ${category}`);
    this.name = "DownloadError";
    this.category = category;
    this.status = status;
  }
}

export interface DownloadedFile {
  /** Staged file path (the caller removes it with `removeStaged`). */
  path: string;
  bytes: number;
  sha256: Buffer;
  /** First `SNIFF_HEAD_BYTES` of the body. */
  head: Buffer;
}

export interface DownloadDeps {
  allowList: GoogleMediaAllowList;
  maxBytes: number;
  /** Staging directory (default `importTmpDir()`). */
  tmpDir?: string;
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  attempts?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface AccessTokenSource {
  /** The current access token. */
  get(): Promise<string>;
  /** A fresh token after a 401 with `stale` (single-flight; may return a newer one). */
  refresh(stale: string): Promise<string>;
}

/** The staged path of an item (ids are uuids: no traversal). */
export function stagedPath(tmpDir: string, itemId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw new DownloadError("disallowed_url");
  return path.join(tmpDir, itemId);
}

/** Remove a staged file; never throws. */
export async function removeStaged(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined);
}

class AttemptError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly failure: DownloadError,
    readonly retryAfter: string | null = null,
  ) {
    super(failure.message);
    this.name = "AttemptError";
  }
}

/**
 * Download `baseUrl=d` for item `itemId` into the staging dir. Throws `DownloadError` on every
 * failure, after removing any partial file.
 */
export async function downloadMedia(
  deps: DownloadDeps,
  token: AccessTokenSource,
  itemId: string,
  baseUrl: string,
): Promise<DownloadedFile> {
  const { allowList, maxBytes } = deps;
  const guard = { exactOrigins: allowList.exactOrigins };
  const start = parseAllowedMediaUrl(mediaDownloadUrl(baseUrl), allowList.hostSuffixes, guard);
  if (!start) throw new DownloadError("disallowed_url");
  const tmpDir = deps.tmpDir ?? importTmpDir();
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const file = stagedPath(tmpDir, itemId);
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = Math.max(1, deps.attempts ?? GOOGLE_CALL_ATTEMPTS);
  const idleMs = deps.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const totalMs = deps.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS;

  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const accessToken = await token.get();
    try {
      return await attemptOnce(accessToken);
    } catch (err) {
      await removeStaged(file);
      if (!(err instanceof AttemptError)) throw new DownloadError("network");
      if (err.failure.category === "unauthorized" && !refreshed) {
        // One fresh token per item; does not count as an attempt.
        refreshed = true;
        await token.refresh(accessToken);
        attempt--;
        continue;
      }
      if (!err.retryable || attempt >= attempts) throw err.failure;
      await sleep(retryDelayMs(attempt, err.retryAfter));
    }
  }

  async function attemptOnce(accessToken: string): Promise<DownloadedFile> {
    const ctrl = new AbortController();
    const total = setTimeout(() => ctrl.abort(), totalMs);
    let idle = setTimeout(() => ctrl.abort(), idleMs);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), idleMs);
    };
    try {
      let url: URL = start as URL;
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        try {
          res = await fetchImpl(url.href, {
            method: "GET",
            headers: { authorization: `Bearer ${accessToken}` },
            redirect: "manual",
            signal: ctrl.signal,
          });
        } catch {
          throw new AttemptError(true, new DownloadError("network"));
        }
        bump();
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          await res.body?.cancel().catch(() => undefined);
          if (hop >= IMPORT_MEDIA_MAX_REDIRECTS) {
            throw new AttemptError(false, new DownloadError("too_many_redirects", res.status));
          }
          const next = resolveMediaRedirect(url, location, allowList.hostSuffixes, {
            ...guard,
            sameHost: true,
          });
          if (!next) throw new AttemptError(false, new DownloadError("disallowed_url", res.status));
          url = next;
          continue;
        }
        break;
      }
      if (!res) throw new AttemptError(true, new DownloadError("network"));
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        throw new AttemptError(false, new DownloadError("unauthorized", 401));
      }
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        await res.body?.cancel().catch(() => undefined);
        throw new AttemptError(
          isRetryableStatus(res.status),
          new DownloadError("http", res.status),
          retryAfter,
        );
      }
      const declared = res.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new AttemptError(false, new DownloadError("file_too_large", res.status));
      }
      if (!res.body) throw new AttemptError(true, new DownloadError("network", res.status));

      const hash = createHash("sha256");
      const headParts: Buffer[] = [];
      let headLen = 0;
      let bytes = 0;
      const fh = await open(file, "w", 0o600);
      try {
        const reader = res.body.getReader();
        try {
          for (;;) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch {
              throw new AttemptError(true, new DownloadError("network", res.status));
            }
            if (chunk.done) break;
            bump();
            const buf = Buffer.from(
              chunk.value.buffer,
              chunk.value.byteOffset,
              chunk.value.byteLength,
            );
            bytes += buf.byteLength;
            if (bytes > maxBytes) {
              ctrl.abort();
              throw new AttemptError(false, new DownloadError("file_too_large", res.status));
            }
            hash.update(buf);
            if (headLen < SNIFF_HEAD_BYTES) {
              const part = buf.subarray(0, SNIFF_HEAD_BYTES - headLen);
              headParts.push(Buffer.from(part));
              headLen += part.byteLength;
            }
            await fh.write(buf);
          }
        } finally {
          reader.releaseLock();
        }
      } finally {
        await fh.close();
      }
      if (bytes === 0) throw new AttemptError(true, new DownloadError("network", res.status));
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) !== bytes) {
        // Truncated body (connection dropped before Content-Length bytes arrived).
        throw new AttemptError(true, new DownloadError("network", res.status));
      }
      return { path: file, bytes, sha256: hash.digest(), head: Buffer.concat(headParts) };
    } catch (err) {
      ctrl.abort();
      if (err instanceof AttemptError) throw err;
      throw new AttemptError(true, new DownloadError("network"));
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
    }
  }
}
