import { describe, expect, it, vi } from "vitest";

// `video.transcode` job handling (docs/plans/step-12.md 2.6 step 4; review fixes, re-review): a
// genuine failure (bad source / failed verification, any ffmpeg exit/crash/kill/oversized output or
// timeout, an ffprobe that ran and failed) on the LAST attempt marks the rendition `failed` + the
// upload file `transcode_failed` and rethrows; a deferrable failure (scratch low, storage, database,
// a MISSING ffmpeg/ffprobe, shutdown, anything unknown) never marks and leaves the row `pending`
// for `ingest.reconcile`; nothing is marked before the last attempt.
// `transcodeVideo` itself is mocked here (its own paths are covered by video.integration.test.ts).

const transcode = vi.hoisted(() => ({ transcodeVideo: vi.fn() }));
vi.mock("./video/transcode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./video/transcode")>();
  return { ...actual, transcodeVideo: transcode.transcodeVideo };
});

import { handleVideoTranscodeJob } from "./queues";
import { StorageError } from "./storage";
import { recordingLog, scriptedPool } from "./testing/stubs";
import { FfmpegError } from "./video/ffmpeg";
import { ProbeError } from "./video/ffprobe";
import { ScratchLowError } from "./video/scratch";
import {
  isDeferrableTranscodeError,
  MARK_RENDITION_SQL,
  MARK_TRANSCODE_FAILED_FILE_SQL,
  TranscodeFailure,
} from "./video/transcode";

const PHOTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BABY = "11111111-1111-4111-8111-111111111111";
const job = (retryCount: number, retryLimit = 2) => ({
  id: "j1",
  data: { photoId: PHOTO, babyId: BABY },
  retryCount,
  retryLimit,
});

function harness() {
  const marks: { sql: string; params: unknown[] }[] = [];
  const pool = scriptedPool({
    [MARK_RENDITION_SQL]: (params) => {
      marks.push({ sql: "rendition", params });
      return { rows: [], rowCount: 1 };
    },
    [MARK_TRANSCODE_FAILED_FILE_SQL]: (params) => {
      marks.push({ sql: "file", params });
      return { rows: [], rowCount: 1 };
    },
    "*": () => ({ rows: [] }),
  });
  const log = recordingLog();
  const deps = {
    pool,
    storage: {} as never,
    log,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    scratchPath: "/tmp/ll-scratch-test",
    threads: 1,
    timeoutSec: 60,
    minFreeBytes: 1,
  } as never;
  const attemptLog = () => log.lines.find((l) => /attempt failed/.test(String(l.msg)));
  return { pool, log, deps, marks, attemptLog };
}

describe("isDeferrableTranscodeError", () => {
  it.each([
    // genuine (the clip / this environment's answer for this clip): marked failed on the last attempt
    [new TranscodeFailure("verify_tags"), false],
    [new TranscodeFailure("source_hash_mismatch"), false],
    [new FfmpegError("timeout"), false],
    [new FfmpegError("exit_nonzero", 1), false],
    [new FfmpegError("killed"), false],
    [new FfmpegError("stdout_too_large"), false],
    [new ProbeError("probe_failed"), false],
    [new ProbeError("unsupported_media_type"), false],
    // deferrable (the environment, not the clip): left pending for ingest.reconcile
    [new FfmpegError("spawn_failed"), true],
    [new ProbeError("probe_failed", true), true],
    [new ScratchLowError(1, 2), true],
    [new StorageError("NoSuchKey"), true],
    [Object.assign(new Error("terminating connection"), { code: "57P01" }), true],
    [new Error("anything"), true],
    [undefined, true],
  ] as [unknown, boolean][])("%s → deferrable %s", (err, expected) => {
    expect(isDeferrableTranscodeError(err)).toBe(expected);
  });

  it("ProbeError carries spawnFailed (default false); FfmpegError's category is the whole message", () => {
    expect(new ProbeError("probe_failed").spawnFailed).toBe(false);
    expect(new ProbeError("probe_failed", true).spawnFailed).toBe(true);
    expect(new ProbeError("probe_failed", true).message).toBe("probe: probe_failed");
    expect(new FfmpegError("exit_nonzero", 1).message).toBe("ffmpeg: exit_nonzero");
  });
});

describe("FfmpegError", () => {
  it("keeps the stderr tail readable but non-enumerable: never serialised into pgboss.job.output", () => {
    const e = new FfmpegError(
      "timeout",
      1,
      "secret /scratch/abc.orig com.apple.quicktime.location",
    );
    expect(e.stderrTail).toContain("secret");
    expect(Object.keys(e)).not.toContain("stderrTail");
    expect(JSON.stringify(e)).not.toContain("secret");
    expect(JSON.stringify({ ...e })).not.toContain("secret");
    expect(e.message).toBe("ffmpeg: timeout");
    expect(e.category).toBe("timeout");
    expect(e.exitCode).toBe(1);
  });
});

describe("handleVideoTranscodeJob", () => {
  it("(1) genuine failure on the last attempt: marks rendition failed + upload file transcode_failed, rethrows, logs giveUp", async () => {
    const h = harness();
    transcode.transcodeVideo.mockRejectedValueOnce(new TranscodeFailure("verify_tags"));
    await expect(handleVideoTranscodeJob(h.deps, job(2))).rejects.toBeInstanceOf(TranscodeFailure);
    expect(h.marks).toEqual([
      { sql: "rendition", params: [PHOTO, "failed"] },
      { sql: "file", params: [PHOTO] },
    ]);
    expect(h.attemptLog()?.level).toBe("warn");
    expect(h.attemptLog()?.obj).toMatchObject({
      photoId: PHOTO,
      attempt: 3,
      deferrable: false,
      giveUp: true,
      reconcile: false,
    });
  });

  it("(2) an ffmpeg timeout on the last attempt is genuine too", async () => {
    const h = harness();
    transcode.transcodeVideo.mockRejectedValueOnce(
      new FfmpegError("timeout", null, "/scratch/x.orig"),
    );
    await expect(handleVideoTranscodeJob(h.deps, job(2))).rejects.toBeInstanceOf(FfmpegError);
    expect(h.marks.map((m) => m.sql)).toEqual(["rendition", "file"]);
    expect(h.attemptLog()?.obj).toMatchObject({
      deferrable: false,
      giveUp: true,
      reconcile: false,
    });
    expect(JSON.stringify(h.log.lines)).not.toContain("/scratch/");
  });

  it("(3) scratch low on the last attempt: no mark, rethrown, left for reconcile", async () => {
    const h = harness();
    transcode.transcodeVideo.mockRejectedValueOnce(new ScratchLowError(1e9, 6e9));
    await expect(handleVideoTranscodeJob(h.deps, job(2))).rejects.toBeInstanceOf(ScratchLowError);
    expect(h.marks).toEqual([]);
    expect(h.attemptLog()?.obj).toMatchObject({ deferrable: true, reconcile: true, giveUp: false });
  });

  it.each([
    ["FfmpegError exit_nonzero", new FfmpegError("exit_nonzero", 1, "/scratch/x.orig secret")],
    ["FfmpegError killed", new FfmpegError("killed", null, "secret")],
    ["FfmpegError stdout_too_large", new FfmpegError("stdout_too_large")],
    ["ProbeError probe_failed (ffprobe ran)", new ProbeError("probe_failed")],
    ["ProbeError unsupported_media_type", new ProbeError("unsupported_media_type")],
  ])(
    "(2b) %s on the last attempt is genuine: rendition failed + file transcode_failed, rethrown",
    async (_n, err) => {
      const h = harness();
      transcode.transcodeVideo.mockRejectedValueOnce(err);
      await expect(handleVideoTranscodeJob(h.deps, job(2))).rejects.toBe(err);
      expect(h.marks).toEqual([
        { sql: "rendition", params: [PHOTO, "failed"] },
        { sql: "file", params: [PHOTO] },
      ]);
      expect(h.attemptLog()?.obj).toMatchObject({
        deferrable: false,
        giveUp: true,
        reconcile: false,
      });
      const lines = JSON.stringify(h.log.lines);
      expect(lines).not.toContain("secret");
      expect(lines).not.toContain("/scratch/");
    },
  );

  it.each([
    ["StorageError NoSuchKey", new StorageError("NoSuchKey")],
    [
      "pg 57P01",
      Object.assign(new Error("terminating connection due to administrator command"), {
        code: "57P01",
      }),
    ],
    ["FfmpegError spawn_failed (ffmpeg missing)", new FfmpegError("spawn_failed")],
    ["ProbeError probe_failed spawnFailed (ffprobe missing)", new ProbeError("probe_failed", true)],
    ["ScratchLowError", new ScratchLowError(1e9, 6e9)],
    ["plain Error", new Error("boom https://secret")],
    ["undefined", undefined],
  ])("(4) %s on the last attempt is deferrable: no mark, rethrown", async (_n, err) => {
    const h = harness();
    transcode.transcodeVideo.mockRejectedValueOnce(err);
    await expect(handleVideoTranscodeJob(h.deps, job(2))).rejects.toBe(err);
    expect(h.marks).toEqual([]);
    expect(h.attemptLog()?.obj).toMatchObject({ deferrable: true, giveUp: false, reconcile: true });
    expect(JSON.stringify(h.log.lines)).not.toContain("secret");
  });

  it("(5) before the last attempt nothing is marked, whatever the error", async () => {
    for (const err of [
      new TranscodeFailure("verify_tags"),
      new FfmpegError("timeout"),
      new FfmpegError("exit_nonzero", 1),
      new FfmpegError("killed"),
      new ProbeError("probe_failed"),
      new ScratchLowError(1, 2),
      new Error("x"),
    ]) {
      const h = harness();
      transcode.transcodeVideo.mockRejectedValue(err);
      await expect(handleVideoTranscodeJob(h.deps, job(0))).rejects.toBe(err);
      await expect(handleVideoTranscodeJob(h.deps, job(1))).rejects.toBe(err);
      transcode.transcodeVideo.mockReset();
      expect(h.marks).toEqual([]);
      expect(h.attemptLog()?.obj).toMatchObject({ giveUp: false, reconcile: false, attempt: 1 });
    }
  });

  it("a mark that itself fails is logged and the original error still propagates", async () => {
    const h = harness();
    const pool = scriptedPool({
      [MARK_RENDITION_SQL]: () => {
        throw new Error("db gone");
      },
      "*": () => ({ rows: [] }),
    });
    transcode.transcodeVideo.mockRejectedValueOnce(new TranscodeFailure("verify_faststart"));
    await expect(
      handleVideoTranscodeJob({ ...(h.deps as object), pool } as never, job(2)),
    ).rejects.toBeInstanceOf(TranscodeFailure);
    expect(
      h.log.lines.some((l) => l.level === "error" && /could not mark failed/.test(String(l.msg))),
    ).toBe(true);
  });

  it("a success passes the result through; an invalid payload is dropped with a warning and no transcode", async () => {
    const h = harness();
    transcode.transcodeVideo.mockResolvedValueOnce({ outcome: "ready", photoId: PHOTO, ms: 5 });
    expect(await handleVideoTranscodeJob(h.deps, job(0))).toEqual({
      outcome: "ready",
      photoId: PHOTO,
      ms: 5,
    });
    transcode.transcodeVideo.mockClear();
    expect(
      await handleVideoTranscodeJob(h.deps, {
        id: "j2",
        data: { photoId: "nope" },
        retryCount: 0,
        retryLimit: 2,
      }),
    ).toBeNull();
    expect(transcode.transcodeVideo).not.toHaveBeenCalled();
    expect(h.marks).toEqual([]);
  });
});
