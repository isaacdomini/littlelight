import { babyPrefix, originalKey, photoPrefixes } from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import {
  AUDIT_PURGED_SQL,
  DELETE_BABY_SQL,
  DELETE_DUPLICATE_SQL,
  DELETE_PHOTO_SQL,
  DUE_BABIES_SQL,
  DUE_PHOTOS_SQL,
  HELD_BABIES_SQL,
  LEFTOVER_DUPLICATES_SQL,
  ORPHAN_UPLOADS_SQL,
  purgeTrash,
} from "./purge";
import { memoryStorage, recordingLog, scriptedPool } from "./testing/stubs";

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A select handler that yields `batches` in order, then []. */
const seq = (...batches: unknown[][]) => {
  const q = [...batches];
  return (params: unknown[]) => ({
    rows: (q.shift() ?? []).filter(
      (r) => !((params[1] as string[] | undefined) ?? []).includes((r as { id: string }).id),
    ),
  });
};

describe("purgeTrash", () => {
  it("deletes every object version BEFORE the row, per photo, and audits the purge", async () => {
    const storage = memoryStorage({ deleteCounts: {} });
    const order: string[] = [];
    const orig = storage.deleteAllVersions.bind(storage);
    storage.deleteAllVersions = async (prefix) => {
      order.push(`objects:${prefix}`);
      return orig(prefix);
    };
    const pool = scriptedPool({
      [DUE_PHOTOS_SQL]: seq([{ id: P1, baby_id: B1 }]),
      [DELETE_PHOTO_SQL]: () => {
        order.push("row");
        return { rowCount: 1 };
      },
      [AUDIT_PURGED_SQL]: () => {
        order.push("audit");
        return { rowCount: 1 };
      },
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    const log = recordingLog();
    const res = await purgeTrash({ pool, storage, log });
    const [orig_, derivs] = photoPrefixes(B1, P1);
    expect(order).toEqual([`objects:${orig_}`, `objects:${derivs}`, "row", "audit"]);
    expect(res.photos).toBe(1);
    expect(res.versionsDeleted).toBe(2);
    expect(res.errors).toBe(0);
    const audit = pool.log.find(([sql]) => sql === AUDIT_PURGED_SQL);
    expect(audit?.[1]).toEqual([B1, JSON.stringify({ photo_id: P1 })]);
  });

  it("a storage failure keeps the row, counts an error, and carries on with the other photos", async () => {
    const storage = memoryStorage();
    const [bad] = photoPrefixes(B1, P1);
    storage.failOn.add(`delete:${bad}`);
    const deleted: unknown[] = [];
    const pool = scriptedPool({
      [DUE_PHOTOS_SQL]: seq([
        { id: P1, baby_id: B1 },
        { id: P2, baby_id: B1 },
      ]),
      [DELETE_PHOTO_SQL]: (params) => {
        deleted.push(params[0]);
        return { rowCount: 1 };
      },
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    const log = recordingLog();
    const res = await purgeTrash({ pool, storage, log });
    expect(deleted).toEqual([P2]);
    expect(res.photos).toBe(1);
    expect(res.errors).toBe(1);
    const warn = log.lines.find((l) => l.level === "warn");
    expect(warn?.obj).toMatchObject({ photoId: P1 });
    expect(JSON.stringify(log.lines)).not.toContain("stub failure"); // category only
  });

  it("excludes ids that failed in this run from the next batch (no infinite retry loop)", async () => {
    const storage = memoryStorage();
    storage.failOn.add(`delete:${photoPrefixes(B1, P1)[0]}`);
    const excluded: unknown[] = [];
    const pool = scriptedPool({
      [DUE_PHOTOS_SQL]: (params) => {
        excluded.push([...(params[1] as string[])]);
        return {
          rows:
            excluded.length === 1
              ? [
                  { id: P1, baby_id: B1 },
                  { id: P2, baby_id: B1 },
                ]
              : [],
        };
      },
      [DELETE_PHOTO_SQL]: () => ({ rowCount: 1 }),
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    // batchSize 2 forces a second select after a full first batch
    await purgeTrash({ pool, storage, log: recordingLog(), batchSize: 2 });
    expect(excluded[0]).toEqual([]);
    expect(excluded[1]).toEqual([P1]);
  });

  it("trashed babies: the whole baby prefix first, then the baby row (cascade)", async () => {
    const storage = memoryStorage({ deleteCounts: { [babyPrefix(B1)]: 5 } });
    const pool = scriptedPool({
      [DUE_BABIES_SQL]: seq([{ id: B1 }]),
      [DELETE_BABY_SQL]: () => ({ rowCount: 1 }),
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    const res = await purgeTrash({ pool, storage, log: recordingLog() });
    expect(storage.calls[0]).toBe(`delete:${babyPrefix(B1)}`);
    expect(res.babies).toBe(1);
    expect(res.versionsDeleted).toBe(5);
    const idx = pool.log.findIndex(([sql]) => sql === DELETE_BABY_SQL);
    expect(idx).toBeGreaterThan(-1);
  });

  it("babies holding a quarantined photo are never selected and are reported (warn)", async () => {
    expect(DUE_BABIES_SQL).toMatch(/NOT EXISTS[\s\S]*quarantined_at IS NOT NULL/);
    expect(DUE_PHOTOS_SQL).toContain("quarantined_at IS NULL");
    expect(DELETE_PHOTO_SQL).toContain("quarantined_at IS NULL");
    const pool = scriptedPool({ [HELD_BABIES_SQL]: () => ({ rows: [{ n: 2 }] }) });
    const log = recordingLog();
    const res = await purgeTrash({ pool, storage: memoryStorage(), log });
    expect(res.babiesHeldForQuarantine).toBe(2);
    expect(log.lines.some((l) => l.level === "warn" && l.obj.count === 2)).toBe(true);
  });

  it("every delete re-checks the 30-day window in SQL (a restored or fresh row is never deleted)", () => {
    for (const sql of [DUE_BABIES_SQL, DELETE_BABY_SQL, DUE_PHOTOS_SQL, DELETE_PHOTO_SQL]) {
      expect(sql).toContain("interval '30 days'");
    }
    expect(DELETE_DUPLICATE_SQL).toContain("status = 'duplicate'");
  });

  it("removes leftover exact-duplicate markers: objects, then row", async () => {
    const storage = memoryStorage();
    const pool = scriptedPool({
      [LEFTOVER_DUPLICATES_SQL]: seq([{ id: P3, baby_id: B2 }]),
      [DELETE_DUPLICATE_SQL]: () => ({ rowCount: 1 }),
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    const res = await purgeTrash({ pool, storage, log: recordingLog() });
    expect(res.duplicates).toBe(1);
    expect(storage.calls).toEqual(photoPrefixes(B2, P3).map((p) => `delete:${p}`));
  });

  it("orphaned upload objects are deleted by storage key, keyset-paginated, errors deferred", async () => {
    const storage = memoryStorage({
      deleteCounts: { [originalKey(B1, P1)]: 1, [originalKey(B1, P2)]: 0 },
    });
    storage.failOn.add(`delete:${originalKey(B1, P3)}`);
    const seen: unknown[][] = [];
    const rows = [
      { id: P1, storage_key: originalKey(B1, P1), updated_at: new Date("2026-06-14T10:00:00Z") },
      { id: P2, storage_key: originalKey(B1, P2), updated_at: new Date("2026-06-14T11:00:00Z") },
      { id: P3, storage_key: originalKey(B1, P3), updated_at: new Date("2026-06-14T12:00:00Z") },
    ];
    const pool = scriptedPool({
      [ORPHAN_UPLOADS_SQL]: (params) => {
        seen.push(params);
        return { rows: seen.length === 1 ? rows : [] };
      },
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    const res = await purgeTrash({ pool, storage, log: recordingLog(), batchSize: 3 });
    expect(res.orphanUploads).toBe(1); // only P1 actually removed something
    expect(res.errors).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([3, rows[2]?.updated_at, P3]); // keyset cursor = last row
  });

  it("only originals of rejected / unsupported uploads are targeted: decode failures and quarantined ones stay", () => {
    expect(ORPHAN_UPLOADS_SQL).toContain("quarantined_at IS NOT NULL");
    expect(ORPHAN_UPLOADS_SQL).toContain("'unsupported_media_type'");
    expect(ORPHAN_UPLOADS_SQL).toContain("f.state IN ('failed', 'aborted')");
  });

  it("with nothing to do it deletes nothing and reports zeros", async () => {
    const storage = memoryStorage();
    const pool = scriptedPool({ [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }) });
    const res = await purgeTrash({ pool, storage, log: recordingLog() });
    expect(res).toEqual({
      babies: 0,
      babiesHeldForQuarantine: 0,
      photos: 0,
      duplicates: 0,
      orphanUploads: 0,
      versionsDeleted: 0,
      errors: 0,
    });
    expect(storage.calls).toEqual([]);
  });

  it("runs as pipeline in short transactions: no storage call happens inside an open transaction", async () => {
    // Every pool client is released before storage is touched for the next row only if the
    // transaction wrapper closes first; check that each client saw COMMIT before any delete call.
    const storage = memoryStorage();
    let open = 0;
    let maxOpenDuringStorage = 0;
    const pool = scriptedPool({
      [DUE_PHOTOS_SQL]: seq([{ id: P1, baby_id: B1 }]),
      [DELETE_PHOTO_SQL]: () => ({ rowCount: 1 }),
      [HELD_BABIES_SQL]: () => ({ rows: [{ n: 0 }] }),
    });
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await connect();
      open++;
      const release = c.release.bind(c);
      c.release = (e?: Error) => {
        open--;
        release(e);
      };
      return c;
    };
    const orig = storage.deleteAllVersions.bind(storage);
    storage.deleteAllVersions = async (p) => {
      maxOpenDuringStorage = Math.max(maxOpenDuringStorage, open);
      return orig(p);
    };
    await purgeTrash({ pool, storage, log: recordingLog() });
    expect(maxOpenDuringStorage).toBe(0);
  });
});
