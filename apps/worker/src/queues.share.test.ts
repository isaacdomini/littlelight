import { JOBS, shareApplyJobSchema } from "@tinyglow/shared";
import { describe, expect, it, vi } from "vitest";
import {
  handleShareApplyJob,
  handleShareReconcileJob,
  QUEUES,
  SHARE_RECONCILE_SEND_OPTIONS,
  sendShareApply,
  shareApplySendOptions,
  startWorkers,
} from "./queues";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";

// Step 8 queues (docs/plans/step-8.md 2.8): definitions, strict send helpers, the two handlers
// (invalid payloads are warned about by job id only and dropped) and their registration.

const LINK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const job = (data: unknown) => ({ id: "job-1", data }) as never;
const result = { links: 1, photos: 2, added: 1, removed: 0, skipped: 0 };
const sharer = () => ({
  evaluatePhotos: vi.fn(async () => result),
  applyLink: vi.fn(async () => result),
  reconcile: vi.fn(async () => result),
});

describe("share queue definitions", () => {
  it("share.apply: exclusive, 2 retries after 30 s, 15 minutes to run", () => {
    expect(QUEUES[JOBS.shareApply]).toEqual({
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      expireInSeconds: 900,
    });
    expect(shareApplySendOptions(LINK)).toEqual({
      singletonKey: LINK,
      retryLimit: 2,
      retryDelay: 30,
      expireInSeconds: 900,
    });
  });

  it("share.reconcile: a cron singleton with no retry", () => {
    expect(QUEUES[JOBS.shareReconcile]).toEqual({
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 3000,
    });
    expect(SHARE_RECONCILE_SEND_OPTIONS).toEqual({ retryLimit: 0, expireInSeconds: 3000 });
  });

  it("sendShareApply validates strictly before sending and keys the job by link", async () => {
    const send = vi.fn(async () => "id");
    await expect(
      sendShareApply({ send } as never, { shareLinkId: "x" } as never),
    ).rejects.toThrow();
    await expect(
      sendShareApply(
        { send } as never,
        { shareLinkId: LINK, reason: "manual", token: "t" } as never,
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await sendShareApply({ send } as never, { shareLinkId: LINK, reason: "rule_changed" });
    expect(send).toHaveBeenCalledWith(
      JOBS.shareApply,
      shareApplyJobSchema.parse({ shareLinkId: LINK, reason: "rule_changed" }),
      shareApplySendOptions(LINK),
    );
  });
});

describe("share handlers", () => {
  it("share.apply runs the parsed link; invalid payloads are dropped with one warn (job id only)", async () => {
    const autoSharer = sharer();
    const log = recordingLog();
    expect(
      await handleShareApplyJob({ autoSharer, log }, job({ shareLinkId: LINK, reason: "manual" })),
    ).toEqual(result);
    expect(autoSharer.applyLink).toHaveBeenCalledWith(LINK);
    for (const bad of [
      null,
      {},
      "x",
      { shareLinkId: LINK },
      { shareLinkId: "nope", reason: "manual" },
      { shareLinkId: LINK, reason: "other" },
      { shareLinkId: LINK, reason: "manual", token: "secret-token" },
    ]) {
      expect(await handleShareApplyJob({ autoSharer, log }, job(bad))).toBeNull();
    }
    expect(autoSharer.applyLink).toHaveBeenCalledTimes(1);
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(7);
    for (const w of warns) expect(w.obj).toEqual({ jobId: "job-1" });
    expect(JSON.stringify(log.lines)).not.toContain("secret-token");
  });

  it("share.reconcile accepts no payload or {}; anything else is dropped", async () => {
    const autoSharer = sharer();
    const log = recordingLog();
    await handleShareReconcileJob({ autoSharer, log }, job(undefined));
    await handleShareReconcileJob({ autoSharer, log }, job({}));
    expect(autoSharer.reconcile).toHaveBeenCalledTimes(2);
    expect(
      await handleShareReconcileJob({ autoSharer, log }, job({ shareLinkId: LINK })),
    ).toBeNull();
    expect(autoSharer.reconcile).toHaveBeenCalledTimes(2);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("sync errors propagate so pg-boss retries / records the failure", async () => {
    const autoSharer = sharer();
    autoSharer.applyLink.mockRejectedValueOnce(new Error("db down"));
    await expect(
      handleShareApplyJob(
        { autoSharer, log: recordingLog() },
        job({ shareLinkId: LINK, reason: "manual" }),
      ),
    ).rejects.toThrow("db down");
  });

  it("startWorkers registers both share queues and routes jobs to the auto-sharer", async () => {
    const registered = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const boss = {
      send: vi.fn(),
      work: vi.fn(async (name: string, _o: unknown, handler: never) => {
        registered.set(name, handler);
        return "w";
      }),
    };
    const autoSharer = sharer();
    await startWorkers(boss as never, {
      ingest: {
        pool: scriptedPool(),
        storage: memoryStorage(),
        matcher: { name: "none", check: async () => ({ matched: false }) },
        dataKey: "k",
        log: recordingLog(),
      } as never,
      purge: {} as never,
      sweep: {} as never,
      dataExport: {} as never,
      ai: { flush: vi.fn(), poll: vi.fn(), backfill: vi.fn() } as never,
      indexer: { reindex: vi.fn(), reconcile: vi.fn(), backfill: vi.fn() } as never,
      autoSharer: autoSharer as never,
      log: recordingLog(),
      ingestConcurrency: 1,
    });
    expect(registered.size).toBe(15);
    await registered.get(JOBS.shareApply)?.([
      job({ shareLinkId: LINK, reason: "rule_changed" }),
      job({ bad: true }),
    ]);
    expect(autoSharer.applyLink).toHaveBeenCalledTimes(1);
    await registered.get(JOBS.shareReconcile)?.([job({})]);
    expect(autoSharer.reconcile).toHaveBeenCalledTimes(1);
  });
});
