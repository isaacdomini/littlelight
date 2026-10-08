import { statfs as fsStatfs } from "node:fs/promises";

// Storage disk-usage alert (docs/plans/step-4.md 2.11 "Disk alert", D11; PRD "Compose
// requirements" 80 % alert). The worker mounts MinIO's data volume read-only at
// STORAGE_DISK_PATH; each heartbeat reads `statfs` and reports `diskUsedPct` in
// `worker_heartbeats.details`. One `warn` when usage crosses STORAGE_DISK_ALERT_PCT, one `info`
// when it is back under; unset path or a failing statfs is logged once and the check is skipped.

export interface StatfsLike {
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
  bsize: number | bigint;
}

export type StatfsFn = (path: string) => Promise<StatfsLike>;

/** Used percentage as `df` computes it: used / (used + available to unprivileged users). */
export function usedPercent(s: StatfsLike): number | undefined {
  const blocks = Number(s.blocks);
  const bfree = Number(s.bfree);
  const bavail = Number(s.bavail);
  const used = blocks - bfree;
  const denom = used + bavail;
  if (!Number.isFinite(denom) || denom <= 0) return undefined;
  return Math.round((used / denom) * 1000) / 10;
}

export interface DiskLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface DiskMonitor {
  /** Current used %, or undefined when the check is disabled or statfs failed. */
  sample(): Promise<number | undefined>;
}

export function createDiskMonitor(opts: {
  path: string | undefined;
  alertPct: number;
  log: DiskLogger;
  statfs?: StatfsFn;
}): DiskMonitor {
  const { path, alertPct, log } = opts;
  const statfs: StatfsFn = opts.statfs ?? ((p) => fsStatfs(p));
  if (!path) {
    log.info({ disk: "disabled" }, "disk alert: STORAGE_DISK_PATH not set, check skipped");
    return { sample: async () => undefined };
  }
  let alerting = false;
  let failing = false;
  let first = true;
  return {
    async sample() {
      let pct: number | undefined;
      try {
        pct = usedPercent(await statfs(path));
      } catch (err) {
        if (!failing) {
          const code = (err as { code?: unknown } | null)?.code;
          log.warn(
            { disk: typeof code === "string" ? code : "error" },
            "disk alert: storage path not readable, check skipped",
          );
          failing = true;
        }
        return undefined;
      }
      failing = false;
      if (pct === undefined) return undefined;
      if (first) {
        first = false;
        log.info({ diskUsedPct: pct, alertPct }, "disk alert: monitoring storage usage");
      }
      if (pct >= alertPct && !alerting) {
        alerting = true;
        log.warn({ diskUsedPct: pct, alertPct }, "disk alert: storage usage above threshold");
      } else if (pct < alertPct && alerting) {
        alerting = false;
        log.info({ diskUsedPct: pct, alertPct }, "disk alert: storage usage back under threshold");
      }
      return pct;
    },
  };
}
