import { randomUUID } from "node:crypto";
import { DEMO_IDS } from "@littlelight/shared";
import { describe, expect, it, vi } from "vitest";
import { jpegWithExif } from "../testing/exif-writer";
import { sceneJpeg } from "../testing/images";
import { type Handler, recordingLog, scriptedPool } from "../testing/stubs";
import {
  checkPassed,
  demoMediaEnabled,
  headSize,
  isMetadataFree,
  isUuid,
  jpegMetadataSegments,
  REVIEW_PHOTOS_SQL,
  reviewOriginalKey,
  writeReviewMedia,
} from "./media";

// Pure parts of the demo media tool and the review-media key filter (docs/plans/step-9.md 2.11,
// 2.15). The real storage/DB round trip is in media.integration.test.ts.

const BABY = "aaaaaaaa-0000-4000-8000-00000000b001";
const OTHER_BABY = "bbbbbbbb-0000-4000-8000-00000000b002";
const pid = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("demoMediaEnabled (the dev-only auto-run gate)", () => {
  it("needs SEED_DEMO_FAMILY=true and a non-production NODE_ENV", () => {
    expect(demoMediaEnabled({ SEED_DEMO_FAMILY: "true" }, "development")).toBe(true);
    expect(demoMediaEnabled({ SEED_DEMO_FAMILY: " TRUE " }, "test")).toBe(true);
    expect(demoMediaEnabled({ SEED_DEMO_FAMILY: "true" }, "production")).toBe(false);
    for (const v of [undefined, "", "false", "1", "yes"]) {
      expect(demoMediaEnabled({ SEED_DEMO_FAMILY: v }, "development"), String(v)).toBe(false);
    }
  });
});

describe("reviewOriginalKey", () => {
  it("is babies/<baby>/originals/<photo>.jpg", () => {
    expect(reviewOriginalKey(BABY, pid(1))).toBe(`babies/${BABY}/originals/${pid(1)}.jpg`);
  });

  it("rejects ids that are not uuids (no path tricks)", () => {
    expect(() => reviewOriginalKey("../x", pid(1))).toThrow();
    expect(() => reviewOriginalKey(BABY, "../../y")).toThrow();
  });
});

describe("isUuid", () => {
  it("accepts lowercase uuids only", () => {
    expect(isUuid(BABY)).toBe(true);
    expect(isUuid(BABY.toUpperCase())).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(`${BABY}x`)).toBe(false);
  });
});

describe("metadata detection", () => {
  it("finds the APPn / COM segments of a JPEG and nothing in a clean one", async () => {
    const clean = await sceneJpeg(64, 64, 1);
    expect(jpegMetadataSegments(clean)).toEqual([]);
    expect(await isMetadataFree(clean)).toBe(true);
    const tagged = jpegWithExif(clean, { make: "Acme", imageDescription: "Mia's first bath" });
    expect(jpegMetadataSegments(tagged)).toContain("APP1");
    expect(await isMetadataFree(tagged)).toBe(false);
  });

  it("flags non-JPEG input", () => {
    expect(jpegMetadataSegments(Buffer.from("GIF89a"))).toEqual(["not-jpeg"]);
    expect(jpegMetadataSegments(Buffer.alloc(0))).toEqual(["not-jpeg"]);
  });
});

describe("headSize", () => {
  it("returns the content length, or null for a missing object", async () => {
    const found = { send: vi.fn(async () => ({ ContentLength: 1234 })) };
    expect(await headSize({ s3: found as never, bucket: "b" }, "k")).toBe(1234);
    for (const err of [
      { name: "NotFound" },
      { name: "NoSuchKey" },
      { $metadata: { httpStatusCode: 404 } },
    ]) {
      const missing = { send: vi.fn(async () => Promise.reject(err)) };
      expect(await headSize({ s3: missing as never, bucket: "b" }, "k")).toBeNull();
    }
  });

  it("rethrows anything else", async () => {
    const down = {
      send: vi.fn(async () =>
        Promise.reject(Object.assign(new Error("boom"), { name: "AccessDenied" })),
      ),
    };
    await expect(headSize({ s3: down as never, bucket: "b" }, "k")).rejects.toThrow("boom");
  });
});

describe("checkPassed", () => {
  const ok = {
    photos: 12,
    expectedPhotos: 12,
    originals: 12,
    derivatives: 36,
    expectedDerivatives: 36,
    rowsMatching: 12,
    metadataFree: 48,
    objectsChecked: 48,
  };
  it("passes only when everything is present, matching and metadata-free", () => {
    expect(checkPassed(ok)).toBe(true);
    expect(checkPassed({ ...ok, originals: 11 })).toBe(false);
    expect(checkPassed({ ...ok, derivatives: 35 })).toBe(false);
    expect(checkPassed({ ...ok, rowsMatching: 11 })).toBe(false);
    expect(checkPassed({ ...ok, metadataFree: 47 })).toBe(false);
    expect(checkPassed({ ...ok, photos: 11 })).toBe(false);
    expect(ok.expectedPhotos).toBe(DEMO_IDS.photos.length);
  });
});

// ---------------------------------------------------------------------------------------------

interface Row {
  id: string;
  baby_id: string;
  storage_key_original: string;
  status: string;
}

function review(rows: Row[], existing: Set<string> = new Set()) {
  const handlers = new Map<string, Handler>([[REVIEW_PHOTOS_SQL, () => ({ rows })]]);
  const pool = scriptedPool(handlers);
  const put: string[] = [];
  const storage = {
    putObject: vi.fn(async (key: string, body: Buffer, type: string) => {
      put.push(key);
      existing.add(key);
      expect(type).toBe("image/jpeg");
      expect(body[0]).toBe(0xff);
    }),
    getObject: vi.fn(),
    deleteAllVersions: vi.fn(),
    listMultipartUploads: vi.fn(),
    abortMultipartUpload: vi.fn(),
  };
  const s3 = {
    send: vi.fn(async (cmd: { input: { Key: string } }) => {
      if (existing.has(cmd.input.Key)) return { ContentLength: 5000 };
      throw Object.assign(new Error("nf"), { name: "NotFound" });
    }),
  };
  const sendIngest = vi.fn(async (job: { photoId: string }) =>
    job.photoId ? `job-${job.photoId}` : null,
  );
  const log = recordingLog();
  const deps = {
    pool: pool as never,
    s3: s3 as never,
    bucket: "b",
    storage: storage as never,
    log,
    sendIngest,
  };
  return { deps, put, storage, s3, sendIngest, log, existing };
}

const good = (n: number, status = "uploaded", baby = BABY): Row => ({
  id: pid(n),
  baby_id: baby,
  storage_key_original: reviewOriginalKey(baby, pid(n)),
  status,
});

describe("writeReviewMedia: key filtering", () => {
  it("writes and enqueues only rows whose key is exactly babies/<thatBaby>/originals/<id>.jpg", async () => {
    const rows: Row[] = [
      good(1),
      good(2),
      // a real upload: no extension
      {
        id: pid(3),
        baby_id: BABY,
        storage_key_original: `babies/${BABY}/originals/${pid(3)}`,
        status: "uploaded",
      },
      // the old pre-fix format outside the baby prefix
      {
        id: pid(4),
        baby_id: BABY,
        storage_key_original: `review/${pid(4)}.jpg`,
        status: "uploaded",
      },
      // another baby's prefix
      {
        id: pid(5),
        baby_id: BABY,
        storage_key_original: reviewOriginalKey(OTHER_BABY, pid(5)),
        status: "uploaded",
      },
      // right prefix, wrong photo id in the key
      {
        id: pid(6),
        baby_id: BABY,
        storage_key_original: reviewOriginalKey(BABY, pid(99)),
        status: "uploaded",
      },
      // path traversal attempt
      {
        id: pid(7),
        baby_id: BABY,
        storage_key_original: `babies/${BABY}/originals/../../${OTHER_BABY}/x.jpg`,
        status: "uploaded",
      },
      // a row of another baby returned by a (hypothetical) bad query
      good(8, "uploaded", OTHER_BABY),
    ];
    const t = review(rows);
    const r = await writeReviewMedia(t.deps, BABY);
    expect(t.put).toEqual([rows[0]?.storage_key_original, rows[1]?.storage_key_original]);
    expect(t.sendIngest.mock.calls.map((c) => c[0])).toEqual([
      { photoId: pid(1), babyId: BABY },
      { photoId: pid(2), babyId: BABY },
    ]);
    expect(r).toMatchObject({
      photos: 8,
      originalsWritten: 2,
      enqueued: 2,
      skippedForeignKey: 6,
      waiting: 2,
    });
    // never a HEAD or put on a foreign key
    const touched = t.s3.send.mock.calls.map((c) => c[0].input.Key);
    for (const row of rows.slice(2)) expect(touched).not.toContain(row.storage_key_original);
  });

  it("rows already ingested are left alone (no write, no job)", async () => {
    const t = review([
      good(1, "ingested"),
      good(2, "ready"),
      good(3, "uploaded"),
      good(4, "failed"),
    ]);
    const r = await writeReviewMedia(t.deps, BABY);
    expect(r.alreadyIngested).toBe(2);
    expect(r.waiting).toBe(2);
    expect(t.sendIngest.mock.calls.map((c) => (c[0] as { photoId: string }).photoId)).toEqual([
      pid(3),
      pid(4),
    ]);
  });

  it("is idempotent: an existing original is not rewritten, the ingest job is still offered", async () => {
    const rows = [good(1), good(2)];
    const existing = new Set(rows.map((r) => r.storage_key_original));
    const t = review(rows, existing);
    const r = await writeReviewMedia(t.deps, BABY);
    expect(r.originalsWritten).toBe(0);
    expect(t.put).toEqual([]);
    expect(r.enqueued).toBe(2);
  });

  it("counts a job that is already queued instead of enqueuing a duplicate", async () => {
    const t = review([good(1), good(2)]);
    t.sendIngest.mockImplementationOnce(async () => null as never);
    const r = await writeReviewMedia(t.deps, BABY);
    expect(r).toMatchObject({ enqueued: 1, alreadyQueued: 1 });
  });

  it("a baby with no photos writes nothing", async () => {
    const t = review([]);
    expect(await writeReviewMedia(t.deps, BABY)).toMatchObject({
      photos: 0,
      waiting: 0,
      enqueued: 0,
    });
    expect(t.storage.putObject).not.toHaveBeenCalled();
  });

  it("logs ids and counts only", async () => {
    const t = review([good(1)]);
    await writeReviewMedia(t.deps, BABY);
    const text = JSON.stringify(t.log.lines);
    expect(text).not.toContain("Sunny");
    expect(text).not.toContain("X-Amz");
  });

  it("writes real metadata-free JPEG bytes", async () => {
    const bodies: Buffer[] = [];
    const t = review([good(1)]);
    t.storage.putObject.mockImplementation(async (_k: string, body: Buffer) => {
      bodies.push(body);
    });
    await writeReviewMedia(t.deps, BABY);
    expect(bodies).toHaveLength(1);
    expect(await isMetadataFree(bodies[0] as Buffer)).toBe(true);
    expect(randomUUID()).toBeTruthy();
  });
});
