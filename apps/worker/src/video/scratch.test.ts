import { readdirSync } from "node:fs";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VIDEO_SCRATCH_MIN_FREE_BYTES, VIDEO_SCRATCH_TTL_HOURS } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertScratchRoom,
  ensureScratchDir,
  fileSize,
  removeScratch,
  ScratchLowError,
  scratchFreeBytes,
  scratchPaths,
  scratchPhotoId,
  sweepScratch,
} from "./scratch";

// The scratch folder (docs/plans/step-12.md Q8, 2.6; review fix M2): names come from the photo id
// only, the free-space guard defers transcodes, and the sweep removes every file older than the TTL
// (a pending row no longer pins its staged original: it is re-downloadable) plus, under
// `minFreeBytes`, the oldest inactive files until the disk is back over the threshold. Everything
// runs in a temp dir; nothing touches /scratch.

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ll-scratch-unit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scratchPaths / scratchPhotoId", () => {
  it("builds <id>.orig and <id>.web.mp4 under the root from a lower-cased uuid; refuses anything else", () => {
    const p = scratchPaths(root, ID.toUpperCase());
    expect(p.orig).toBe(path.join(root, `${ID}.orig`));
    expect(p.web).toBe(path.join(root, `${ID}.web.mp4`));
    for (const bad of ["../etc/passwd", "clip.mov", "", `${ID}/x`, "aaaaaaaa-aaaa-4aaa-8aaa"]) {
      expect(() => scratchPaths(root, bad), bad).toThrow(TypeError);
    }
  });

  it("recovers the photo id from our file names only", () => {
    expect(scratchPhotoId(`${ID}.orig`)).toBe(ID);
    expect(scratchPhotoId(`${ID.toUpperCase()}.web.mp4`)).toBe(ID);
    expect(scratchPhotoId(`${ID}.keyframe1.jpg`)).toBe(ID);
    expect(scratchPhotoId("lost+found")).toBeNull();
    expect(scratchPhotoId(".DS_Store")).toBeNull();
    expect(scratchPhotoId("notauuid.orig")).toBeNull();
  });
});

describe("files", () => {
  it("ensureScratchDir creates the root (0700), fileSize reads sizes and null for missing, removeScratch never throws", async () => {
    const dir = path.join(root, "nested", "scratch");
    await ensureScratchDir(dir);
    await ensureScratchDir(dir); // idempotent
    const p = scratchPaths(dir, ID);
    await writeFile(p.orig, Buffer.alloc(123));
    expect(await fileSize(p.orig)).toBe(123);
    expect(await fileSize(p.web)).toBeNull();
    await removeScratch(dir, ID);
    expect(await fileSize(p.orig)).toBeNull();
    await expect(removeScratch(dir, ID)).resolves.toBeUndefined();
  });
});

describe("free space guard", () => {
  const fs =
    (bavail: number, bsize = 4096) =>
    async () => ({ bavail, bsize });

  it("scratchFreeBytes multiplies bavail × bsize (bigint tolerated)", async () => {
    expect(await scratchFreeBytes(root, fs(1000, 4096))).toBe(4_096_000);
    expect(await scratchFreeBytes(root, async () => ({ bavail: 10n, bsize: 512n }))).toBe(5120);
  });

  it("assertScratchRoom passes at or above the floor and throws ScratchLowError below it (defaults to 6 GiB)", async () => {
    expect(await assertScratchRoom(root, 4096, fs(1))).toBe(4096);
    await expect(assertScratchRoom(root, 4097, fs(1))).rejects.toBeInstanceOf(ScratchLowError);
    try {
      await assertScratchRoom(root, 8192, fs(1));
    } catch (e) {
      const err = e as ScratchLowError;
      expect(err.freeBytes).toBe(4096);
      expect(err.minFreeBytes).toBe(8192);
      expect(err.message).not.toContain(root);
    }
    await expect(assertScratchRoom(root, undefined, fs(1))).rejects.toBeInstanceOf(ScratchLowError);
    expect(await assertScratchRoom(root, undefined, fs(VIDEO_SCRATCH_MIN_FREE_BYTES / 4096))).toBe(
      VIDEO_SCRATCH_MIN_FREE_BYTES,
    );
  });
});

describe("sweepScratch", () => {
  const H = 3_600_000;
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * H);
  const put = async (name: string, when?: Date, size = 1) => {
    const p = path.join(root, name);
    await writeFile(p, Buffer.alloc(size, 1));
    if (when) await utimes(p, when, when);
  };
  const names = async () => (await readdir(root)).sort();
  /** A statfs stub whose free space is the given byte count (bsize 1), counting calls. */
  const statfsOf = (free: () => number, calls: number[] = []) => {
    const fn = async () => {
      calls.push(1);
      return { bavail: free(), bsize: 1 };
    };
    return { fn, calls };
  };

  it("(a) TTL: removes every scratch file older than 6 h, a PENDING video's staged .orig included (re-downloadable); younger and foreign files stay", async () => {
    await put(`${ID}.orig`, ago(VIDEO_SCRATCH_TTL_HOURS + 1)); // pending video, stale
    await put(`${ID}.web.mp4`, ago(VIDEO_SCRATCH_TTL_HOURS + 1));
    await put(`${ID2}.orig`, ago(2)); // young
    await put(`${ID2}.keyframe1.jpg`); // fresh
    await put("lost+found", ago(100)); // not ours
    expect(VIDEO_SCRATCH_TTL_HOURS).toBe(6);
    const r = await sweepScratch(root);
    expect(r).toEqual({ scanned: 4, removed: 2, kept: 2, lowSpaceRemoved: 0, errors: 0 });
    expect(await names()).toEqual([`${ID2}.keyframe1.jpg`, `${ID2}.orig`, "lost+found"].sort());
  });

  it("(a2) honours a custom ttl / clock, does nothing when nothing is old, survives a missing root", async () => {
    await put(`${ID}.orig`, ago(2));
    expect(await sweepScratch(root, { ttlHours: 6 })).toEqual({
      scanned: 1,
      removed: 0,
      kept: 1,
      lowSpaceRemoved: 0,
      errors: 0,
    });
    expect((await sweepScratch(root, { ttlHours: 1 })).removed).toBe(1);
    await put(`${ID}.orig`);
    const future = await sweepScratch(root, { now: () => new Date(now + 10 * H) });
    expect(future.removed).toBe(1);
    const missing = await sweepScratch(path.join(root, "nope"));
    expect(missing).toEqual({ scanned: 0, removed: 0, kept: 0, lowSpaceRemoved: 0, errors: 0 });
    // the sweep never takes the "keep" callback any more: a pending row cannot pin a file
    expect("keep" in (missing as object)).toBe(false);
  });

  it("(b) low space: below minFreeBytes the oldest files older than activeMs go one at a time until statfs reports enough; younger files stay; freeBytes reported", async () => {
    const ID3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await put(`${ID}.orig`, ago(5), 100); // oldest candidate (young for the TTL)
    await put(`${ID2}.orig`, ago(3), 100); // second candidate
    await put(`${ID3}.orig`, ago(2), 100); // third candidate, must survive
    await put(`${ID3}.web.mp4`, ago(0.5), 100); // inside activeMs: an active transcode may read it
    // free space grows by 100 per removal: 50 → 150 → 250; threshold 200 ⇒ two removals
    const removedSoFar = () => 4 - readdirSync(root).length;
    const { fn, calls } = statfsOf(() => 50 + 100 * removedSoFar());
    const r = await sweepScratch(root, {
      ttlHours: 6,
      minFreeBytes: 200,
      activeMs: H,
      statfs: fn,
      now: () => new Date(now),
    });
    expect(r).toEqual({
      scanned: 4,
      removed: 0,
      kept: 2,
      lowSpaceRemoved: 2,
      freeBytes: 250,
      errors: 0,
    });
    expect(await names()).toEqual([`${ID3}.orig`, `${ID3}.web.mp4`].sort());
    // statfs: once before, once after each removal
    expect(calls).toHaveLength(3);
  });

  it("(b2) low space with nothing eligible: files inside activeMs are never touched, freeBytes still reported; enough space ⇒ no removal and one statfs call", async () => {
    await put(`${ID}.orig`, ago(0.2), 10);
    const low = await sweepScratch(root, { minFreeBytes: 1e12, statfs: statfsOf(() => 5).fn });
    expect(low).toMatchObject({ lowSpaceRemoved: 0, kept: 1, freeBytes: 5 });
    expect(await names()).toEqual([`${ID}.orig`]);
    const { fn, calls } = statfsOf(() => 1e12);
    await put(`${ID2}.orig`, ago(3));
    const fine = await sweepScratch(root, { minFreeBytes: 1e6, statfs: fn });
    expect(fine).toMatchObject({ lowSpaceRemoved: 0, kept: 2, freeBytes: 1e12 });
    expect(calls).toHaveLength(1);
  });

  it("(c) a failing statfs is one error, the low-space pass is skipped (TTL pass still ran), no freeBytes, nothing young removed", async () => {
    await put(`${ID}.orig`, ago(VIDEO_SCRATCH_TTL_HOURS + 1));
    await put(`${ID2}.orig`, ago(3));
    const r = await sweepScratch(root, {
      minFreeBytes: 1e12,
      activeMs: 1,
      statfs: async () => {
        throw new Error("ENOENT: statfs '/mnt/data/scratch'");
      },
    });
    expect(r).toEqual({ scanned: 2, removed: 1, kept: 1, lowSpaceRemoved: 0, errors: 1 });
    expect("freeBytes" in r).toBe(false);
    expect(await names()).toEqual([`${ID2}.orig`]);
  });

  it("without minFreeBytes there is no low-space pass and no statfs call at all", async () => {
    await put(`${ID}.orig`, ago(3));
    const { fn, calls } = statfsOf(() => 0);
    const r = await sweepScratch(root, { statfs: fn });
    expect(calls).toHaveLength(0);
    expect(r).toEqual({ scanned: 1, removed: 0, kept: 1, lowSpaceRemoved: 0, errors: 0 });
  });
});
