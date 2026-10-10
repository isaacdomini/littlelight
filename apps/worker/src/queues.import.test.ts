import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { JOBS } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import {
  handleImportSweepJob,
  IMPORT_SWEEP_SEND_OPTIONS,
  importGoogleSendOptions,
  QUEUES,
  SCHEDULES,
  schedules,
  sendImportGoogle,
  startWorkers,
} from "./queues";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";

const run = promisify(execFile);
const TSX = path.resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");

// Step 10 queues (docs/plans/step-10.md 2.3, 2.7): import.google and import.sweep definitions,
// strict send helper, handler registration, sweep cron, logger redaction.

const BATCH = "11111111-1111-4111-8111-111111111111";
const BABY = "22222222-2222-4222-8222-222222222222";
const ids = { batchId: BATCH, babyId: BABY };

describe("import queue definitions", () => {
  it("import.google: exclusive, 2 retries 60 s apart, 2 hours to run", () => {
    expect(QUEUES[JOBS.importGoogle]).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 7200,
    });
    expect(importGoogleSendOptions(ids)).toEqual({
      singletonKey: BATCH,
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 7200,
    });
  });

  it("import.sweep: a cron singleton with no retry", () => {
    expect(QUEUES[JOBS.importSweep]).toEqual({
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 3000,
    });
    expect(IMPORT_SWEEP_SEND_OPTIONS).toEqual({ retryLimit: 0, expireInSeconds: 3000 });
  });

  it("there are 16 queues, 4 fixed schedules and 8 with the config-driven ones", () => {
    expect(Object.keys(QUEUES)).toHaveLength(16);
    expect(SCHEDULES).toHaveLength(4);
    const all = schedules({
      AI_FLUSH_INTERVAL_CRON: "*/5 * * * *",
      AI_POLL_INTERVAL_CRON: "*/5 * * * *",
    });
    expect(all).toHaveLength(8);
    expect(Object.fromEntries(all)[JOBS.importSweep]).toBe("37 * * * *");
    expect(Object.fromEntries(all)[JOBS.importGoogle]).toBeUndefined(); // on demand only
  });

  it("sendImportGoogle validates strictly before sending and keys by batch", async () => {
    const send = vi.fn(async () => "id");
    for (const bad of [
      { batchId: "x", babyId: BABY },
      { ...ids, refreshToken: "1//x" },
      { ...ids, tzHint: "UTC" },
      {},
    ])
      await expect(sendImportGoogle({ send } as never, bad as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await sendImportGoogle({ send } as never, ids);
    expect(send).toHaveBeenCalledWith(JOBS.importGoogle, ids, importGoogleSendOptions(ids));
  });
});

describe("startWorkers: import handlers", () => {
  function boot(withImport: boolean) {
    const registered = new Map<
      string,
      { options: Record<string, unknown>; handler: (jobs: unknown[]) => Promise<void> }
    >();
    const boss = {
      send: vi.fn(async () => "job"),
      work: vi.fn(async (name: string, options: Record<string, unknown>, handler: never) => {
        registered.set(name, { options, handler });
        return "w";
      }),
    };
    const log = recordingLog();
    const pool = scriptedPool();
    return startWorkers(boss as never, {
      ingest: {
        pool,
        storage: memoryStorage(),
        matcher: { name: "none", check: async () => ({ matched: false }) },
        dataKey: "k",
        log,
      } as never,
      purge: {} as never,
      sweep: { pool, storage: memoryStorage() } as never,
      dataExport: {} as never,
      ai: { flush: vi.fn(), poll: vi.fn(), backfill: vi.fn() } as never,
      indexer: { reindex: vi.fn(), reconcile: vi.fn(), backfill: vi.fn() } as never,
      autoSharer: { evaluatePhotos: vi.fn(), applyLink: vi.fn(), reconcile: vi.fn() } as never,
      ...(withImport
        ? {
            importGoogle: {
              pool,
              storage: memoryStorage(),
              dataKey: "k",
              google: null,
              download: { allowList: { hostSuffixes: [], exactOrigins: [] }, maxBytes: 1 },
              concurrency: 1,
              log,
            } as never,
          }
        : {}),
      log,
      ingestConcurrency: 1,
    }).then(() => ({ registered, boss, log, pool }));
  }

  it("registers import.google (one batch at a time, with metadata) when its deps are given, and import.sweep always", async () => {
    const { registered } = await boot(true);
    expect(registered.size).toBe(16);
    expect(registered.get(JOBS.importGoogle)?.options).toMatchObject({
      batchSize: 1,
      localConcurrency: 1,
      includeMetadata: true,
    });
    expect(registered.has(JOBS.importSweep)).toBe(true);
  });

  it("without import deps, import.google gets no handler (jobs wait) but the sweep still runs", async () => {
    const { registered } = await boot(false);
    expect(registered.size).toBe(15);
    expect(registered.has(JOBS.importGoogle)).toBe(false);
    expect(registered.has(JOBS.importSweep)).toBe(true);
  });

  it("an invalid import.google payload is dropped without touching the database", async () => {
    const { registered, pool, log } = await boot(true);
    await registered
      .get(JOBS.importGoogle)
      ?.handler([{ id: "j1", data: { batchId: "x" }, retryCount: 0, retryLimit: 2 }]);
    expect(pool.log).toEqual([]);
    expect(
      log.lines.some((l) => l.level === "warn" && String(l.msg).includes("invalid job payload")),
    ).toBe(true);
  });

  it("an invalid import.sweep payload is dropped", async () => {
    const log = recordingLog();
    const r = await handleImportSweepJob(
      { sweep: { pool: scriptedPool(), storage: memoryStorage() }, log } as never,
      { send: vi.fn() } as never,
      { id: "j", data: { x: 1 } } as never,
    );
    expect(r).toBeNull();
    expect(log.lines.at(-1)?.msg).toContain("invalid job payload");
  });
});

describe("worker logger redaction (step 10)", () => {
  it("censors Google tokens, media URLs, the picker URL, Google ids and file names", async () => {
    const script = `
      import { createLogger } from ${JSON.stringify(path.resolve(import.meta.dirname, "logger.ts"))};
      const log = createLogger({ LOG_LEVEL: "info", NODE_ENV: "production" });
      log.info({
        refresh_token: "fake-refresh-SECRET", access_token: "fake-access-SECRET",
        grant: { refreshToken: "RT-SECRET", accessToken: "AT-SECRET", baseUrl: "http://g/media/BASE-SECRET", pickerUri: "http://g/picker/PICK-SECRET" },
        item: { filename: "IMG_FILE-SECRET.jpg", provider_item_id: "ITEM-SECRET", provider_session_id: "SESS-SECRET", href: "http://g/HREF-SECRET" },
        res: { headers: { authorization: "Bearer HDR-SECRET" } },
        batchId: "keep-me",
      }, "probe");
    `;
    const { stdout } = await run(TSX, ["--eval", script], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      timeout: 60_000,
    });
    expect(stdout).toContain("keep-me");
    expect(stdout).not.toMatch(/SECRET/);
  });
});
