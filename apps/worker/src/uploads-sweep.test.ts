import { describe, expect, it } from "vitest";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";
import {
  EXPIRED_FILES_SQL,
  MARK_EXPIRED_SQL,
  REGISTERED_UPLOAD_IDS_SQL,
  sweepUploads,
} from "./uploads-sweep";

const NOW = new Date("2026-06-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";

const once = <T>(rows: T[]) => {
  let used = false;
  return () => {
    if (used) return { rows: [] };
    used = true;
    return { rows };
  };
};

describe("sweepUploads", () => {
  it("aborts the multipart upload of an expired registered file, then marks it aborted/expired", async () => {
    const storage = memoryStorage();
    const marked: unknown[] = [];
    const pool = scriptedPool({
      [EXPIRED_FILES_SQL]: once([
        { id: F1, storage_key: "babies/b/originals/f1", multipart_upload_id: "up-1" },
      ]),
      [MARK_EXPIRED_SQL]: (p) => {
        marked.push(p[0]);
        return { rowCount: 1 };
      },
    });
    const res = await sweepUploads({ pool, storage, log: recordingLog(), now: () => NOW });
    expect(storage.calls[0]).toBe("abort:babies/b/originals/f1:up-1");
    expect(marked).toEqual([F1]);
    expect(res).toMatchObject({ expiredFiles: 1, strayUploads: 0, errors: 0 });
    // The state change is guarded in SQL and sets the plan's error value.
    expect(MARK_EXPIRED_SQL).toContain("state = 'aborted', error = 'expired'");
    expect(MARK_EXPIRED_SQL).toContain("state = 'registered'");
    expect(EXPIRED_FILES_SQL).toContain("s.expires_at < now()");
  });

  it("a file without a multipart id is just marked; an already-changed row is not counted", async () => {
    const storage = memoryStorage();
    const pool = scriptedPool({
      [EXPIRED_FILES_SQL]: once([
        { id: F1, storage_key: "k1", multipart_upload_id: null },
        { id: F2, storage_key: "k2", multipart_upload_id: "up-2" },
      ]),
      [MARK_EXPIRED_SQL]: (p) => ({ rowCount: p[0] === F1 ? 1 : 0 }),
    });
    const res = await sweepUploads({ pool, storage, log: recordingLog(), now: () => NOW });
    expect(storage.calls.filter((c) => c.startsWith("abort:"))).toEqual(["abort:k2:up-2"]);
    expect(res.expiredFiles).toBe(1);
  });

  it("an abort failure leaves the file registered (retried next run) and does not stop the others", async () => {
    const storage = memoryStorage();
    storage.failOn.add("abort:k1:up-1");
    const marked: unknown[] = [];
    const pool = scriptedPool({
      [EXPIRED_FILES_SQL]: once([
        { id: F1, storage_key: "k1", multipart_upload_id: "up-1" },
        { id: F2, storage_key: "k2", multipart_upload_id: "up-2" },
      ]),
      [MARK_EXPIRED_SQL]: (p) => {
        marked.push(p[0]);
        return { rowCount: 1 };
      },
    });
    const log = recordingLog();
    const res = await sweepUploads({ pool, storage, log, now: () => NOW });
    expect(marked).toEqual([F2]);
    expect(res).toMatchObject({ expiredFiles: 1, errors: 1 });
    expect(JSON.stringify(log.lines)).not.toContain("stub failure");
  });

  it("aborts stray multipart uploads older than 48 h that no registered file references", async () => {
    const storage = memoryStorage({
      multipart: [
        { key: "babies/b/originals/old-orphan", uploadId: "u-old", initiated: hoursAgo(49) },
        { key: "babies/b/originals/old-live", uploadId: "u-live", initiated: hoursAgo(72) },
        { key: "babies/b/originals/young", uploadId: "u-young", initiated: hoursAgo(47) },
        { key: "babies/b/originals/unknown-age", uploadId: "u-na", initiated: null },
      ],
    });
    const pool = scriptedPool({
      [EXPIRED_FILES_SQL]: () => ({ rows: [] }),
      [REGISTERED_UPLOAD_IDS_SQL]: (p) => {
        expect(p[0]).toEqual(["u-old", "u-live"]); // only the old ones are even looked up
        return { rows: [{ multipart_upload_id: "u-live" }] };
      },
    });
    const res = await sweepUploads({ pool, storage, log: recordingLog(), now: () => NOW });
    expect(storage.calls).toContain("list:babies/");
    expect(storage.calls.filter((c) => c.startsWith("abort:"))).toEqual([
      "abort:babies/b/originals/old-orphan:u-old",
    ]);
    expect(res.strayUploads).toBe(1);
  });

  it("only ever lists under babies/ (never other buckets prefixes)", async () => {
    const storage = memoryStorage();
    const pool = scriptedPool({ [EXPIRED_FILES_SQL]: () => ({ rows: [] }) });
    await sweepUploads({ pool, storage, log: recordingLog(), now: () => NOW });
    expect(storage.calls.filter((c) => c.startsWith("list:"))).toEqual(["list:babies/"]);
  });

  it("nothing to do: debug only, zero counts, no state change", async () => {
    const storage = memoryStorage();
    const pool = scriptedPool({ [EXPIRED_FILES_SQL]: () => ({ rows: [] }) });
    const log = recordingLog();
    const res = await sweepUploads({ pool, storage, log, now: () => NOW });
    expect(res).toEqual({ expiredFiles: 0, strayUploads: 0, errors: 0 });
    expect(log.lines.map((l) => l.level)).toEqual(["debug"]);
    expect(pool.appQueries().map(([s]) => s)).toEqual([EXPIRED_FILES_SQL]);
  });

  it("a stray abort failure is counted and logged by category", async () => {
    const storage = memoryStorage({
      multipart: [{ key: "k", uploadId: "u", initiated: hoursAgo(60) }],
    });
    storage.failOn.add("abort:k:u");
    const pool = scriptedPool({
      [EXPIRED_FILES_SQL]: () => ({ rows: [] }),
      [REGISTERED_UPLOAD_IDS_SQL]: () => ({ rows: [] }),
    });
    const res = await sweepUploads({ pool, storage, log: recordingLog(), now: () => NOW });
    expect(res).toMatchObject({ strayUploads: 0, errors: 1 });
  });

  it("does not keep re-selecting a file whose abort failed (exclusion list)", async () => {
    const storage = memoryStorage();
    storage.failOn.add("abort:k1:up-1");
    const seen: unknown[] = [];
    const pool = scriptedPool({
      [EXPIRED_FILES_SQL]: (p) => {
        seen.push([...(p[1] as string[])]);
        return {
          rows:
            seen.length === 1
              ? [
                  { id: F1, storage_key: "k1", multipart_upload_id: "up-1" },
                  { id: F3, storage_key: "k3", multipart_upload_id: "up-3" },
                ]
              : [],
        };
      },
      [MARK_EXPIRED_SQL]: () => ({ rowCount: 1 }),
    });
    await sweepUploads({ pool, storage, log: recordingLog(), now: () => NOW, batchSize: 2 });
    expect(seen).toEqual([[], [F1]]);
  });
});
