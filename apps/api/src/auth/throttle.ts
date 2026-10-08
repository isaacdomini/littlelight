import { createHash } from "node:crypto";

// In-house sliding-window throttle (docs/plans/step-3.md 2.9, R5). In-memory, per API process:
// resets on restart and does not aggregate across replicas; production runs one API container
// and GoTrue's global email cap is the backstop. Keys (emails, IPs) are stored as SHA-256
// digests so a heap dump or a stray log line never shows who was throttled.

export interface ThrottleOptions {
  /** Max hits per key inside the window. */
  limit: number;
  windowMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ThrottleResult {
  allowed: boolean;
  /** Hits counted in the window after this call (capped at `limit` when denied). */
  count: number;
  /** Seconds until a denied key is allowed again (0 when allowed). */
  retryAfterSec: number;
}

export interface Throttle {
  /** Record a hit and report whether it is within the limit. Denied hits are not recorded. */
  hit(key: string): ThrottleResult;
  /** Hits currently counted in the window, without recording one. */
  count(key: string): number;
  /** Forget a key (e.g. after a successful code verification). */
  reset(key: string): void;
  /** Drop expired entries; also runs automatically on a timer. */
  sweep(): void;
  /** Stop the sweep timer. */
  close(): void;
  readonly limit: number;
  readonly windowMs: number;
}

/** Sweep cadence: bounded memory without a sweep on every hit. */
const SWEEP_EVERY_MS = 60_000;

function digest(key: string): string {
  return createHash("sha256").update(key).digest("base64url");
}

export function createThrottle(opts: ThrottleOptions): Throttle {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("throttle: bad limit");
  if (!(opts.windowMs > 0)) throw new Error("throttle: bad window");
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  function live(k: string, t: number): number[] {
    const list = hits.get(k);
    if (!list) return [];
    const cutoff = t - opts.windowMs;
    // Timestamps are appended in order, so drop the expired prefix.
    let i = 0;
    while (i < list.length && (list[i] as number) <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) hits.delete(k);
    return list;
  }

  function sweep() {
    const t = now();
    for (const k of [...hits.keys()]) live(k, t);
  }

  const timer = setInterval(sweep, SWEEP_EVERY_MS);
  timer.unref();

  return {
    limit: opts.limit,
    windowMs: opts.windowMs,
    hit(key) {
      const t = now();
      const k = digest(key);
      const list = live(k, t);
      if (list.length >= opts.limit) {
        const oldest = list[0] as number;
        const retryAfterSec = Math.max(1, Math.ceil((oldest + opts.windowMs - t) / 1000));
        return { allowed: false, count: list.length, retryAfterSec };
      }
      list.push(t);
      hits.set(k, list);
      return { allowed: true, count: list.length, retryAfterSec: 0 };
    },
    count(key) {
      return live(digest(key), now()).length;
    },
    reset(key) {
      hits.delete(digest(key));
    },
    sweep,
    close() {
      clearInterval(timer);
      hits.clear();
    },
  };
}
