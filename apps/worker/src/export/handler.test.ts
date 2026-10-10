import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportMailer } from "../email/mailer";
import { StorageError } from "../storage";
import {
  BABY_ID,
  EXPORT_ID,
  exportPool,
  exportStorageStub,
  fixtureBytes,
  photoId,
  STORAGE_KEY,
} from "../testing/export";
import { recordingLog } from "../testing/stubs";
import {
  type DataExportDeps,
  ExportFailure,
  exportErrorOf,
  handleDataExportJob,
  RETRYABLE_EXPORT_ERRORS,
  runDataExport,
} from "./handler";
import {
  AUDIT_EXPORT_SQL,
  CANCEL_QUEUED_EXPORT_SQL,
  MARK_CANCELLED_SQL,
  MARK_FAILED_SQL,
  MARK_READY_SQL,
  PHOTO_ROWS_SQL,
  PHOTO_ROWS_WITH_GPS_SQL,
  REQUESTER_EMAIL_SQL,
  REQUESTER_IS_ADMIN_SQL,
  REQUEUE_SQL,
  SET_PHOTO_COUNT_SQL,
} from "./sql";

const job = { exportId: EXPORT_ID, babyId: BABY_ID };
const KEY = "k".repeat(40);

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
});

function fakeMailer() {
  const sent: { kind: "ready" | "failed"; to: string; mail: unknown }[] = [];
  const mailer: ExportMailer = {
    sendExportReady: async (to, mail) => void sent.push({ kind: "ready", to, mail }),
    sendExportFailed: async (to, mail) => void sent.push({ kind: "failed", to, mail }),
    close: () => undefined,
  };
  return { mailer, sent };
}

async function make(
  o: {
    count?: number;
    includeLocation?: boolean;
    isAdmin?: boolean;
    noClaim?: boolean;
    email?: string | null;
    extra?: Parameters<typeof exportPool>[0]["extra"];
    mailer?: ExportMailer | null;
    maxBytes?: number;
  } = {},
) {
  const storage = await exportStorageStub();
  disposers.push(storage.dispose);
  const photos = Array.from({ length: o.count ?? 3 }, (_, i) => ({
    id: photoId(i + 1),
    lat: 47.6062,
    lng: -122.3321,
  }));
  photos.forEach((p, i) => {
    storage.objects.set(`babies/${BABY_ID}/originals/${p.id}`, () =>
      Readable.from([fixtureBytes(i)]),
    );
  });
  const pool = exportPool({
    photos,
    includeLocation: o.includeLocation,
    isAdmin: o.isAdmin,
    noClaim: o.noClaim,
    email: o.email,
    extra: o.extra,
  });
  const log = recordingLog();
  const deps: DataExportDeps = {
    pool,
    storage,
    dataKey: KEY,
    maxBytes: o.maxBytes ?? 2 ** 40,
    mailer: o.mailer === undefined ? null : o.mailer,
    log,
  };
  return { deps, pool, storage, log, photos };
}

const sqls = (pool: ReturnType<typeof exportPool>) => pool.log.map(([sql]) => sql);

describe("handleDataExportJob: payload", () => {
  it.each([
    ["extra keys", { ...job, includeLocation: true }],
    ["a missing id", { exportId: EXPORT_ID }],
    ["null", null],
    ["a string", "x"],
  ])("drops a payload with %s, logging the job id only", async (_n, data) => {
    const t = await make();
    const res = await handleDataExportJob(t.deps, { id: "job-1", data });
    expect(res.outcome).toBe("invalid");
    expect(t.pool.log).toEqual([]);
    expect(t.storage.calls).toEqual([]);
    expect(JSON.stringify(t.log.lines)).not.toContain(EXPORT_ID);
  });

  it("derives retry flags from the pg-boss metadata", async () => {
    const t = await make({ noClaim: true });
    const res = await handleDataExportJob(t.deps, {
      id: "j",
      data: job,
      retryCount: 1,
      retryLimit: 1,
    });
    expect(res.outcome).toBe("skipped");
  });
});

describe("runDataExport: claim", () => {
  it("does nothing when the export is not queued (duplicate delivery, purged, expired early)", async () => {
    const t = await make({ noClaim: true });
    const res = await runDataExport(t.deps, job);
    expect(res).toMatchObject({ outcome: "skipped", photos: 0 });
    expect(sqls(t.pool)).toContain(CANCEL_QUEUED_EXPORT_SQL);
    expect(t.storage.calls).toEqual([]);
    expect(sqls(t.pool)).not.toContain(AUDIT_EXPORT_SQL);
  });
});

describe("runDataExport: requester must still be an admin", () => {
  it("fails requester_not_admin before touching storage, with no GPS statement and no retry", async () => {
    const t = await make({ isAdmin: false, includeLocation: true });
    const res = await runDataExport(t.deps, job, { retry: false, lastAttempt: false });
    expect(res).toMatchObject({ outcome: "failed", error: "requester_not_admin" });
    expect(sqls(t.pool)).not.toContain(PHOTO_ROWS_WITH_GPS_SQL);
    expect(sqls(t.pool)).not.toContain(PHOTO_ROWS_SQL);
    expect(
      t.storage.calls.some((c) => c.startsWith("put:") || c.startsWith("getObjectStream:")),
    ).toBe(false);
    const failed = t.pool.log.find(([sql]) => sql === MARK_FAILED_SQL);
    expect(failed?.[1]).toEqual([EXPORT_ID, "requester_not_admin"]);
    const audit = t.pool.log.find(([sql]) => sql === AUDIT_EXPORT_SQL);
    expect(audit?.[1]).toEqual([
      BABY_ID,
      "export.failed",
      JSON.stringify({ export_id: EXPORT_ID }),
    ]);
  });

  it("a requester demoted between the claim and the GPS read stops the export (checked in the GPS transaction)", async () => {
    let calls = 0;
    const t = await make({
      includeLocation: true,
      extra: {
        [REQUESTER_IS_ADMIN_SQL]: () => {
          calls++;
          return { rows: [{ ok: calls === 1 }] }; // true at the start, false in the GPS transaction
        },
      },
    });
    const res = await runDataExport(t.deps, job);
    expect(res).toMatchObject({ outcome: "failed", error: "requester_not_admin" });
    expect(calls).toBe(2);
  });
});

describe("runDataExport: GPS handling", () => {
  it("without include_location never runs the decrypting statement and never binds the data key", async () => {
    const t = await make({ includeLocation: false });
    await runDataExport(t.deps, job);
    expect(sqls(t.pool)).toContain(PHOTO_ROWS_SQL);
    expect(sqls(t.pool)).not.toContain(PHOTO_ROWS_WITH_GPS_SQL);
    expect(t.pool.log.some(([sql]) => sql.includes("app.data_key"))).toBe(false);
  });

  it("with include_location checks the admin gate in the same transaction that decrypts, and binds the key only there", async () => {
    const t = await make({ includeLocation: true });
    await runDataExport(t.deps, job);
    const keyed = t.pool.log.filter(([sql]) => sql.includes("app.data_key"));
    expect(keyed.length).toBeGreaterThan(0);
    for (const [, params] of keyed) expect(params).toEqual([KEY]);
    // In each keyed transaction the admin gate precedes the decrypting SELECT.
    const log = sqls(t.pool);
    for (let i = 0; i < log.length; i++) {
      if (log[i] === PHOTO_ROWS_WITH_GPS_SQL) {
        const keyAt = log.lastIndexOf("SELECT set_config('app.data_key', $1, true)", i);
        const gateAt = log.lastIndexOf(REQUESTER_IS_ADMIN_SQL, i);
        expect(keyAt).toBeGreaterThan(-1);
        expect(gateAt).toBeGreaterThan(keyAt);
      }
    }
  });
});

describe("runDataExport: size limit", () => {
  it("too_large when the originals exceed EXPORT_MAX_BYTES: failed, no upload, no retry", async () => {
    const t = await make({ maxBytes: 1000 });
    const res = await runDataExport(t.deps, job, { retry: false, lastAttempt: false });
    expect(res).toMatchObject({ outcome: "failed", error: "too_large" });
    expect(
      t.storage.calls.filter((c) => c.startsWith("put:") || c.startsWith("getObjectStream:")),
    ).toEqual([]);
    expect(sqls(t.pool)).not.toContain(SET_PHOTO_COUNT_SQL);
  });

  it("an album exactly at the limit is exported", async () => {
    const t = await make({ count: 2, maxBytes: 2 * 4096 });
    expect((await runDataExport(t.deps, job)).outcome).toBe("ready");
  });
});

describe("runDataExport: storage failures and retries", () => {
  it("with a retry left: re-queues the row, deletes the partial ZIP and rethrows", async () => {
    const t = await make();
    t.storage.failGet.add(`babies/${BABY_ID}/originals/${photoId(2)}`);
    await expect(
      runDataExport(t.deps, job, { retry: false, lastAttempt: false }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(sqls(t.pool)).toContain(REQUEUE_SQL);
    expect(sqls(t.pool)).not.toContain(MARK_FAILED_SQL);
    expect(t.storage.calls).toContain(`delete:${STORAGE_KEY}`);
    expect(sqls(t.pool)).not.toContain(AUDIT_EXPORT_SQL);
  });

  it("on the last attempt: marks failed storage_error, audits, emails and rethrows for pg-boss", async () => {
    const m = fakeMailer();
    const t = await make({ mailer: m.mailer });
    t.storage.failGet.add(`babies/${BABY_ID}/originals/${photoId(2)}`);
    await expect(
      runDataExport(t.deps, job, { retry: true, lastAttempt: true }),
    ).rejects.toBeInstanceOf(StorageError);
    const failed = t.pool.log.find(([sql]) => sql === MARK_FAILED_SQL);
    expect(failed?.[1]).toEqual([EXPORT_ID, "storage_error"]);
    expect(t.pool.log.filter(([sql]) => sql === AUDIT_EXPORT_SQL)).toHaveLength(1);
    expect(m.sent.map((s) => s.kind)).toEqual(["failed"]);
  });

  it("an upload failure is a storage_error", async () => {
    const t = await make();
    t.storage.failPut = true;
    await expect(
      runDataExport(t.deps, job, { retry: true, lastAttempt: true }),
    ).rejects.toBeDefined();
    expect(t.pool.log.find(([sql]) => sql === MARK_FAILED_SQL)?.[1]).toEqual([
      EXPORT_ID,
      "storage_error",
    ]);
  });

  it("an unexpected error is internal (retryable like storage)", async () => {
    const t = await make({
      extra: {
        [SET_PHOTO_COUNT_SQL]: () => {
          throw new Error("boom with mom@example.com");
        },
      },
    });
    await expect(
      runDataExport(t.deps, job, { retry: false, lastAttempt: false }),
    ).rejects.toThrow();
    expect(sqls(t.pool)).toContain(REQUEUE_SQL);
    expect(JSON.stringify(t.log.lines)).not.toContain("mom@example.com");
  });

  it("error classification", () => {
    expect(exportErrorOf(new ExportFailure("too_large"))).toBe("too_large");
    expect(exportErrorOf(new StorageError("NoSuchKey"))).toBe("storage_error");
    expect(exportErrorOf(new Error("x"))).toBe("internal");
    expect(RETRYABLE_EXPORT_ERRORS).toEqual(["storage_error", "internal"]);
  });
});

describe("runDataExport: cancelled by an admin", () => {
  it("when the row is no longer running at the end: partial ZIP deleted, status expired, no ready audit", async () => {
    const t = await make({ extra: { [MARK_READY_SQL]: () => ({ rows: [] }) } });
    const res = await runDataExport(t.deps, job);
    expect(res.outcome).toBe("cancelled");
    expect(sqls(t.pool)).toContain(MARK_CANCELLED_SQL);
    expect(t.storage.calls).toContain(`delete:${STORAGE_KEY}`);
    expect(sqls(t.pool)).not.toContain(AUDIT_EXPORT_SQL);
  });
});

describe("runDataExport: email (no link)", () => {
  it("emails the requester when ready; the mail input carries a name and an expiry, never a URL", async () => {
    const m = fakeMailer();
    const t = await make({ mailer: m.mailer });
    const res = await runDataExport(t.deps, job);
    expect(res).toMatchObject({ outcome: "ready", emailed: true });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ kind: "ready", to: "mom@example.test" });
    expect(Object.keys(m.sent[0]?.mail as object).sort()).toEqual(["babyName", "expiresAt"]);
    expect(JSON.stringify(m.sent[0]?.mail)).not.toMatch(/https?:|exports\/|\.zip|X-Amz/);
  });

  it("sends nothing when the requester function returns NULL (left the album, deleted, demoted)", async () => {
    const m = fakeMailer();
    const t = await make({ mailer: m.mailer, email: null });
    const res = await runDataExport(t.deps, job);
    expect(res).toMatchObject({ outcome: "ready", emailed: false });
    expect(m.sent).toEqual([]);
    expect(sqls(t.pool)).toContain(REQUESTER_EMAIL_SQL);
  });

  it("without SMTP the export still completes and the email query is never made", async () => {
    const t = await make({ mailer: null });
    const res = await runDataExport(t.deps, job);
    expect(res).toMatchObject({ outcome: "ready", emailed: false });
    expect(sqls(t.pool)).not.toContain(REQUESTER_EMAIL_SQL);
    expect(t.log.lines.some((l) => l.obj.reason === "smtp_unconfigured")).toBe(true);
  });

  it("a mail failure never fails the export", async () => {
    const mailer: ExportMailer = {
      sendExportReady: async () => {
        throw new Error("smtp down for mom@example.test");
      },
      sendExportFailed: async () => undefined,
      close: () => undefined,
    };
    const t = await make({ mailer });
    const res = await runDataExport(t.deps, job);
    expect(res).toMatchObject({ outcome: "ready", emailed: false });
    expect(JSON.stringify(t.log.lines)).not.toContain("mom@example.test");
  });

  it("emails a failure notice for too_large", async () => {
    const m = fakeMailer();
    const t = await make({ mailer: m.mailer, maxBytes: 10 });
    await runDataExport(t.deps, job);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ kind: "failed", mail: { error: "too_large" } });
  });
});

describe("runDataExport: logs", () => {
  it("never carry an email, key, URL, coordinate or the data key, in success or failure", async () => {
    const m = fakeMailer();
    for (const variant of [{}, { maxBytes: 10 }, { isAdmin: false }]) {
      const t = await make({ mailer: m.mailer, includeLocation: true, ...variant });
      await runDataExport(t.deps, job).catch(() => undefined);
      const text = JSON.stringify(t.log.lines);
      for (const banned of [
        "mom@example.test",
        "47.6062",
        "-122.3321",
        "X-Amz",
        "babies/",
        ".zip",
        KEY,
      ])
        expect(text, `${JSON.stringify(variant)} ${banned}`).not.toContain(banned);
    }
  });
});

void vi;
