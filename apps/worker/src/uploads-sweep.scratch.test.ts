import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";
import { sweepUploads } from "./uploads-sweep";

// `uploads.sweep` step 3 (docs/plans/step-12.md 2.6; review fix M2): scratch files older than 6 h
// are removed whether or not their video is still `pending` (the staged original is re-downloadable),
// then a low-space pass releases the oldest inactive files while the disk is under the threshold;
// without `scratchPath` nothing on disk is touched. No video query is made any more: the pool only
// answers the upload-file / multipart queries.

const PENDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let root: string;
const old = new Date(Date.now() - 7 * 3_600_000);
const recent = new Date(Date.now() - 2 * 3_600_000);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ll-sweep-scratch-"));
  for (const name of [`${PENDING}.orig`, `${DONE}.orig`, `${DONE}.web.mp4`]) {
    const p = path.join(root, name);
    await writeFile(p, "x");
    await utimes(p, old, old);
  }
  await writeFile(path.join(root, `${DONE}.keyframe1.jpg`), "young");
  await utimes(path.join(root, `${DONE}.keyframe1.jpg`), recent, recent);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A pool answering the sweep's SQL with no rows (no expired files, no stray uploads); `log` records every statement. */
const pool = () => scriptedPool();

describe("sweepUploads: scratch", () => {
  it("TTL pass: removes every 6 h-old file, the pending video's staged original included; keeps the young one; reports counters; no video query", async () => {
    const db = pool();
    const log = recordingLog();
    const r = await sweepUploads({
      pool: db,
      storage: memoryStorage(),
      log,
      scratchPath: root,
      scratchMinFreeBytes: 0, // the disk is never "low" at 0: TTL pass only
    });
    expect(r).toMatchObject({
      expiredFiles: 0,
      strayUploads: 0,
      errors: 0,
      scratchRemoved: 3,
      scratchLowSpaceRemoved: 0,
      scratchKept: 1,
    });
    expect(typeof r.scratchFreeBytes).toBe("number");
    expect(r.scratchFreeBytes).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual([`${DONE}.keyframe1.jpg`]);
    expect(db.log.map(([sql]) => sql).join("\n")).not.toMatch(/rendition_status|media_kind/);
    const lines = JSON.stringify(log.lines);
    expect(lines).toContain("sweep: done");
    expect(lines).not.toContain(root);
    expect(lines).not.toMatch(/scratch low/);
  });

  it("low-space pass: under the threshold the young file past scratchActiveSec goes too, with a warn line and counters", async () => {
    const log = recordingLog();
    const r = await sweepUploads({
      pool: pool(),
      storage: memoryStorage(),
      log,
      scratchPath: root,
      scratchMinFreeBytes: Number.MAX_SAFE_INTEGER, // never satisfiable: every inactive file goes
      scratchActiveSec: 3600, // the 2 h-old keyframe is inactive
    });
    expect(r).toMatchObject({
      errors: 0,
      scratchRemoved: 3,
      scratchLowSpaceRemoved: 1,
      scratchKept: 0,
    });
    expect(await readdir(root)).toEqual([]);
    const warn = log.lines.find((l) => l.level === "warn" && /scratch low/.test(String(l.msg)));
    expect(warn?.obj).toMatchObject({ scratchLowSpaceRemoved: 1 });
    expect(JSON.stringify(log.lines)).not.toContain(root);
  });

  it("low-space pass leaves files inside scratchActiveSec alone (an active transcode may be reading them)", async () => {
    const r = await sweepUploads({
      pool: pool(),
      storage: memoryStorage(),
      log: recordingLog(),
      scratchPath: root,
      scratchMinFreeBytes: Number.MAX_SAFE_INTEGER,
      scratchActiveSec: 3 * 3600, // the 2 h-old keyframe counts as active
    });
    expect(r).toMatchObject({ scratchRemoved: 3, scratchLowSpaceRemoved: 0, scratchKept: 1 });
    expect(await readdir(root)).toEqual([`${DONE}.keyframe1.jpg`]);
  });

  it("without scratchPath the folder is untouched and the result has no scratch counters", async () => {
    const r = await sweepUploads({
      pool: pool(),
      storage: memoryStorage(),
      log: recordingLog(),
    });
    expect(r).toEqual({ expiredFiles: 0, strayUploads: 0, errors: 0 });
    expect(await readdir(root)).toHaveLength(4);
  });
});
