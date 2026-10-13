import { VIDEO_TRANSCODE_STUCK_MINUTES } from "@tinyglow/shared";
import { describe, expect, it } from "vitest";
import {
  COUNT_STUCK_VIDEOS_SQL,
  countStuckVideos,
  RECONCILE_REPEAT_WARN,
  RECONCILE_SQL,
  RECONCILE_VIDEO_SQL,
  reconcileIngest,
} from "./reconcile";
import { recordingLog, scriptedPool } from "./testing/stubs";

// `ingest.reconcile` for videos (docs/plans/step-12.md 2.3, 2.6): ingested videos whose rendition is
// still `pending` after VIDEO_TRANSCODE_STUCK_MINUTES are re-sent to `video.transcode`; trashed and
// quarantined rows never; without the transcode sender (pre-step-12 callers) nothing video happens.

const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const V3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BABY = "11111111-1111-4111-8111-111111111111";

describe("RECONCILE_VIDEO_SQL", () => {
  it("targets ingested videos with a pending rendition older than the stuck window, never trashed/quarantined, bounded", () => {
    expect(RECONCILE_VIDEO_SQL).toContain("media_kind = 'video'");
    expect(RECONCILE_VIDEO_SQL).toContain("rendition_status = 'pending'");
    expect(RECONCILE_VIDEO_SQL).toContain("status = 'ingested'");
    expect(RECONCILE_VIDEO_SQL).toContain("make_interval(mins => $1)");
    expect(RECONCILE_VIDEO_SQL).toContain("deleted_at IS NULL");
    expect(RECONCILE_VIDEO_SQL).toContain("quarantined_at IS NULL");
    expect(RECONCILE_VIDEO_SQL).toContain("LIMIT 200");
    expect(VIDEO_TRANSCODE_STUCK_MINUTES).toBe(15);
  });
});

describe("reconcileIngest with videos", () => {
  it("re-sends video.transcode per stuck rendition, binding the stuck window, counting sent / already queued / failed", async () => {
    let boundMinutes: unknown;
    const pool = scriptedPool({
      [RECONCILE_SQL]: () => ({ rows: [] }),
      [RECONCILE_VIDEO_SQL]: (params) => {
        boundMinutes = params[0];
        return {
          rows: [
            { id: V1, baby_id: BABY },
            { id: V2, baby_id: BABY },
            { id: V3, baby_id: BABY },
          ],
        };
      },
    });
    const sent: unknown[] = [];
    const log = recordingLog();
    const res = await reconcileIngest({
      pool,
      log,
      send: async () => "never",
      sendTranscode: async (job) => {
        sent.push(job);
        if (job.photoId === V2) return null; // already queued (singleton key)
        if (job.photoId === V3) throw new Error("boom https://secret/scratch/x.orig");
        return "job-id";
      },
    });
    expect(boundMinutes).toBe(VIDEO_TRANSCODE_STUCK_MINUTES);
    expect(res).toEqual({
      stuck: 0,
      sent: 0,
      alreadyQueued: 1,
      failed: 1,
      videosStuck: 3,
      videosSent: 1,
    });
    expect(sent).toEqual([
      { photoId: V1, babyId: BABY },
      { photoId: V2, babyId: BABY },
      { photoId: V3, babyId: BABY },
    ]);
    const lines = JSON.stringify(log.lines);
    expect(lines).not.toContain("secret");
    expect(lines).not.toContain("/scratch/");
    expect(log.lines.some((l) => l.level === "info" && /re-sent/.test(String(l.msg)))).toBe(true);
  });

  it("without sendTranscode the video query is never run and the result has no video counters", async () => {
    let videoQueried = false;
    const pool = scriptedPool({
      [RECONCILE_SQL]: () => ({ rows: [] }),
      [RECONCILE_VIDEO_SQL]: () => {
        videoQueried = true;
        return { rows: [{ id: V1, baby_id: BABY }] };
      },
    });
    const res = await reconcileIngest({ pool, log: recordingLog(), send: async () => "x" });
    expect(videoQueried).toBe(false);
    expect(res).toEqual({ stuck: 0, sent: 0, alreadyQueued: 0, failed: 0 });
  });

  it("the transcode payload carries ids only", async () => {
    const pool = scriptedPool({
      [RECONCILE_SQL]: () => ({ rows: [] }),
      [RECONCILE_VIDEO_SQL]: () => ({ rows: [{ id: V1, baby_id: BABY }] }),
    });
    let job: unknown;
    await reconcileIngest({
      pool,
      log: recordingLog(),
      send: async () => "x",
      sendTranscode: async (j) => {
        job = j;
        return "y";
      },
    });
    expect(Object.keys(job as object).sort()).toEqual(["babyId", "photoId"]);
  });

  it("(S2) the third re-send of the same video logs the repeat warning (ids + count only); the first two do not; another video has its own count", async () => {
    const pool = scriptedPool({
      [RECONCILE_SQL]: () => ({ rows: [] }),
      [RECONCILE_VIDEO_SQL]: () => ({
        rows: [
          { id: V1, baby_id: BABY },
          { id: V2, baby_id: BABY },
        ],
      }),
    });
    const resendCounts = new Map<string, number>();
    const log = recordingLog();
    const repeatWarns = () =>
      log.lines.filter((l) => l.level === "warn" && /re-sent repeatedly/.test(String(l.msg)));
    const run = (v2Queued = false) =>
      reconcileIngest({
        pool,
        log,
        resendCounts,
        send: async () => "x",
        sendTranscode: async (job) => (v2Queued && job.photoId === V2 ? null : "job"),
      });
    expect(RECONCILE_REPEAT_WARN).toBe(3);
    await run();
    await run(true); // V2 already queued: not a re-send, its count stays at 1
    expect(repeatWarns()).toEqual([]);
    expect(resendCounts.get(V1)).toBe(2);
    expect(resendCounts.get(V2)).toBe(1);
    await run();
    const warns = repeatWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj).toEqual({ photoId: V1, babyId: BABY, resends: 3 });
    expect(resendCounts.get(V2)).toBe(2);
    await run();
    // V1 at 4 warns again, V2 at 3 warns for the first time
    expect(repeatWarns()).toHaveLength(3);
    expect(
      repeatWarns()
        .map((w) => (w.obj as { resends: number }).resends)
        .sort(),
    ).toEqual([3, 3, 4]);
    expect(JSON.stringify(log.lines)).not.toMatch(/\/scratch|https?:/);
  });

  it("a failed send does not count as a re-send", async () => {
    const pool = scriptedPool({
      [RECONCILE_SQL]: () => ({ rows: [] }),
      [RECONCILE_VIDEO_SQL]: () => ({ rows: [{ id: V1, baby_id: BABY }] }),
    });
    const resendCounts = new Map<string, number>();
    const log = recordingLog();
    for (let i = 0; i < 4; i++) {
      await reconcileIngest({
        pool,
        log,
        resendCounts,
        send: async () => "x",
        sendTranscode: async () => {
          throw new Error("boss down");
        },
      });
    }
    expect(resendCounts.size).toBe(0);
    expect(log.lines.some((l) => /re-sent repeatedly/.test(String(l.msg)))).toBe(false);
  });
});

describe("countStuckVideos (heartbeat details.videosPendingStuck)", () => {
  it("counts only ingested, live videos whose rendition has been pending for more than 15 min (same predicate as the re-send query)", () => {
    expect(COUNT_STUCK_VIDEOS_SQL).toContain("count(*)::int AS n");
    for (const clause of [
      "media_kind = 'video'",
      "rendition_status = 'pending'",
      "status = 'ingested'",
      "make_interval(mins => $1)",
      "deleted_at IS NULL",
      "quarantined_at IS NULL",
    ]) {
      expect(COUNT_STUCK_VIDEOS_SQL, clause).toContain(clause);
      expect(RECONCILE_VIDEO_SQL, clause).toContain(clause);
    }
    expect(COUNT_STUCK_VIDEOS_SQL).not.toContain("LIMIT");
    expect(COUNT_STUCK_VIDEOS_SQL).not.toMatch(/rendition_status = 'failed'|'ready'/);
  });

  it("binds VIDEO_TRANSCODE_STUCK_MINUTES and returns n (0 without a row)", async () => {
    let bound: unknown;
    const pool = scriptedPool({
      [COUNT_STUCK_VIDEOS_SQL]: (params) => {
        bound = params[0];
        return { rows: [{ n: 7 }] };
      },
    });
    expect(await countStuckVideos(pool)).toBe(7);
    expect(bound).toBe(VIDEO_TRANSCODE_STUCK_MINUTES);
    expect(await countStuckVideos(scriptedPool())).toBe(0);
  });
});
