import { ingestJobSchema, JOBS } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type IngestDeps,
  LOAD_PHOTO_SQL,
  MARK_FAILED_FILE_SQL,
  MARK_FAILED_PHOTO_SQL,
} from "./ingest";
import {
  ensureQueues,
  ensureSchedules,
  handleIngestJob,
  ingestSendOptions,
  QUEUES,
  SCHEDULES,
  sendIngest,
} from "./queues";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BABY = "11111111-1111-4111-8111-111111111111";
const valid = { photoId: PHOTO, babyId: BABY, uploadFileId: PHOTO };

function deps(
  pool: ReturnType<typeof scriptedPool>,
): IngestDeps & { log: ReturnType<typeof recordingLog> } {
  return {
    pool,
    storage: memoryStorage(),
    matcher: { name: "none", check: async () => ({ matched: false }) },
    dataKey: "k",
    log: recordingLog(),
  };
}
const job = (data: unknown, retryCount = 0, retryLimit = 3) => ({
  id: "job-1",
  data,
  retryCount,
  retryLimit,
  createdOn: new Date(),
});

/** Pool where loading the photo fails like a database outage; markers are recorded. */
function failingLoadPool() {
  return scriptedPool({
    [LOAD_PHOTO_SQL]: () => {
      throw Object.assign(new Error("connection terminated"), { code: "57P01" });
    },
    [MARK_FAILED_PHOTO_SQL]: () => ({ rowCount: 1 }),
    [MARK_FAILED_FILE_SQL]: () => ({ rowCount: 1 }),
  });
}

describe("handleIngestJob", () => {
  it("drops a malformed payload without touching the database and without throwing", async () => {
    for (const data of [
      null,
      {},
      { photoId: "nope" },
      { ...valid, extra: "x" },
      { ...valid, tzHint: "Not/AZone" },
      "string",
    ]) {
      const pool = scriptedPool();
      const d = deps(pool);
      await expect(handleIngestJob(d, job(data))).resolves.toBeUndefined();
      expect(pool.log, JSON.stringify(data)).toEqual([]);
      expect(
        d.log.lines.some((l) => l.level === "warn" && l.msg.includes("invalid job payload")),
      ).toBe(true);
    }
  });

  it("a transient failure on an early attempt is rethrown for pg-boss to retry and marks nothing failed", async () => {
    const pool = failingLoadPool();
    const d = deps(pool);
    await expect(handleIngestJob(d, job(valid, 0, 3))).rejects.toMatchObject({ code: "57P01" });
    await expect(handleIngestJob(d, job(valid, 2, 3))).rejects.toBeTruthy();
    const marks = pool
      .appQueries()
      .filter(([sql]) => sql === MARK_FAILED_PHOTO_SQL || sql === MARK_FAILED_FILE_SQL);
    expect(marks).toEqual([]);
    expect(d.log.lines.filter((l) => l.level === "warn").map((l) => l.obj.giveUp)).toEqual([
      false,
      false,
    ]);
  });

  it("only on the LAST attempt is the photo marked failed with storage_error (and the error still thrown)", async () => {
    const pool = failingLoadPool();
    const d = deps(pool);
    await expect(handleIngestJob(d, job(valid, 3, 3))).rejects.toMatchObject({ code: "57P01" });
    const qs = pool.appQueries();
    expect(qs.find(([sql]) => sql === MARK_FAILED_PHOTO_SQL)?.[1]).toEqual([PHOTO]);
    expect(qs.find(([sql]) => sql === MARK_FAILED_FILE_SQL)?.[1]).toEqual([PHOTO, "storage_error"]);
    expect(d.log.lines.find((l) => l.level === "warn")?.obj).toMatchObject({
      giveUp: true,
      attempt: 4,
      err: "57P01",
    });
  });

  it("log lines carry the photo id and an error category, never the error message", async () => {
    const pool = failingLoadPool();
    const d = deps(pool);
    await handleIngestJob(d, job(valid, 3, 3)).catch(() => undefined);
    expect(JSON.stringify(d.log.lines)).not.toContain("connection terminated");
  });

  it("a failure while marking failed is logged, and the original error still propagates", async () => {
    const pool = scriptedPool({
      [LOAD_PHOTO_SQL]: () => {
        throw new Error("outage");
      },
      [MARK_FAILED_PHOTO_SQL]: () => {
        throw new Error("also down");
      },
    });
    const d = deps(pool);
    await expect(handleIngestJob(d, job(valid, 3, 3))).rejects.toThrow("outage");
    expect(d.log.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("a photo that does not exist is skipped (success), not retried", async () => {
    const pool = scriptedPool({ [LOAD_PHOTO_SQL]: () => ({ rows: [] }) });
    await expect(handleIngestJob(deps(pool), job(valid))).resolves.toBeUndefined();
  });
});

describe("queue definitions", () => {
  it("every queue is exclusive and covers every job name", () => {
    expect(Object.keys(QUEUES).sort()).toEqual(Object.values(JOBS).sort());
    for (const q of Object.values(QUEUES)) expect(q.policy).toBe("exclusive");
  });

  it("photo.ingest retries 3 times with backoff and wakes workers on send", () => {
    expect(QUEUES[JOBS.ingest]).toMatchObject({
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 600,
      notify: true,
    });
  });

  it("schedules: reconcile every 5 min, purge hourly, sweep twice an hour", () => {
    expect(Object.fromEntries(SCHEDULES)).toEqual({
      [JOBS.ingestReconcile]: "*/5 * * * *",
      [JOBS.purgeTrash]: "7 * * * *",
      [JOBS.uploadsSweep]: "23,53 * * * *",
    });
  });

  it("ingest send options use the photo id as singleton key (one queued copy per photo)", () => {
    expect(ingestSendOptions(PHOTO)).toEqual({
      singletonKey: PHOTO,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 600,
    });
  });

  it("sendIngest validates the payload before sending", async () => {
    const send = vi.fn(async () => "id");
    await expect(sendIngest({ send } as never, { photoId: "x" } as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await sendIngest({ send } as never, valid);
    expect(send).toHaveBeenCalledWith(
      JOBS.ingest,
      ingestJobSchema.parse(valid),
      ingestSendOptions(PHOTO),
    );
  });

  it("ensureQueues creates every queue and warns about a policy mismatch", async () => {
    const created: string[] = [];
    const log = recordingLog();
    await ensureQueues(
      {
        createQueue: async (name: string) => void created.push(name),
        getQueue: async (name: string) => ({
          name,
          policy: name === JOBS.purgeTrash ? "standard" : "exclusive",
        }),
      } as never,
      log,
    );
    expect(created.sort()).toEqual(Object.values(JOBS).sort());
    expect(log.lines.filter((l) => l.level === "warn").map((l) => l.obj.queue)).toEqual([
      JOBS.purgeTrash,
    ]);
  });

  it("ensureSchedules schedules every cron in UTC", async () => {
    const calls: unknown[][] = [];
    await ensureSchedules({ schedule: async (...a: unknown[]) => void calls.push(a) } as never, {
      AI_FLUSH_INTERVAL_CRON: "*/5 * * * *",
      AI_POLL_INTERVAL_CRON: "*/10 * * * *",
    });
    expect(calls).toHaveLength(6);
    for (const c of calls) expect(c[3]).toEqual({ tz: "UTC" });
    // Search reconcile falls back to the shared default when the config omits it.
    expect(calls.map((c) => [c[0], c[1]])).toContainEqual([JOBS.searchReconcile, "17 * * * *"]);
    expect(calls.map((c) => [c[0], c[1]])).toContainEqual([JOBS.aiFlush, "*/5 * * * *"]);
    expect(calls.map((c) => [c[0], c[1]])).toContainEqual([JOBS.aiPoll, "*/10 * * * *"]);
  });
});
