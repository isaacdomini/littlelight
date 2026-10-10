import { Readable } from "node:stream";
import {
  type DataExportJob,
  dataExportJobSchema,
  EXPORT_PROGRESS_EVERY,
  type ExportError,
} from "@tinyglow/shared";
import { ZipArchive } from "archiver";
import { errorCategory } from "../clients";
import { type PipelinePool, runAsPipeline } from "../db";
import type { ExportMailer } from "../email/mailer";
import type { WorkerLog } from "../log-types";
import {
  type ObjectStorage,
  STREAM_PART_BYTES,
  STREAM_QUEUE_SIZE,
  StorageError,
  type StreamingStorage,
} from "../storage";
import {
  albumJson,
  type BabyRow,
  type ManifestEntry,
  MEASUREMENTS_CSV_COLUMNS,
  type MeasurementRow,
  type MemberRow,
  MILESTONES_CSV_COLUMNS,
  type MilestoneRow,
  measurementCsvRow,
  milestoneCsvRows,
  originalFileName,
  type PhotoMetaRow,
  photoCsvRow,
  photoJson,
  photosCsvHeader,
  readmeText,
} from "./content";
import { CSV_BOM, csvHeader } from "./csv";
import {
  AUDIT_EXPORT_SQL,
  BABY_SQL,
  CANCEL_QUEUED_EXPORT_SQL,
  CLAIM_EXPORT_SQL,
  MANIFEST_PAGE_SQL,
  MARK_CANCELLED_SQL,
  MARK_FAILED_SQL,
  MARK_READY_SQL,
  MEASUREMENTS_PAGE_SQL,
  MEMBERS_SQL,
  MILESTONES_SQL,
  PHOTO_ROWS_SQL,
  PHOTO_ROWS_WITH_GPS_SQL,
  PROGRESS_SQL,
  REQUESTER_EMAIL_SQL,
  REQUESTER_IS_ADMIN_SQL,
  REQUEUE_SQL,
  SET_PHOTO_COUNT_SQL,
} from "./sql";

// `data.export` (docs/plans/review-fixes.md 2.3, 2.4; PRD FR-10.1 "Export all originals + a
// JSON/CSV of metadata as a ZIP"). One job builds one ZIP at `data_exports.storage_key`
// (`babies/<baby>/exports/<export>.zip`) as `pipeline`:
//
//   claim (queued → running) → requester still admin? → manifest (photo set, size check) →
//   stream README / CSV / JSON / originals through archiver into a lib-storage multipart
//   upload → ready + audit `export.ready` → email (no link).
//
// Memory stays bounded whatever the album size (R1): the ZIP is never held in memory or on disk
// (archiver → `putObjectStream`, at most `partSize × queueSize` buffered), originals are read as
// streams one at a time (the next GetObject is only issued after archiver's `entry` event for the
// previous one), and the CSV/JSON entries are generated lazily, 200 photos per database round
// trip. The manifest (ids, keys, sizes, file names) is the only per-photo state kept for the
// whole run (~300 bytes per photo).
//
// Location: GPS is decrypted only when the row says `include_location` AND
// `export_requester_is_admin()` is true in the same transaction as the decrypting SELECT, and
// only that transaction gets the data key. A requester who is no longer an admin fails the export
// (`requester_not_admin`), with or without location.
//
// Failure: the upload is aborted, every version of the key deleted, the row marked `failed` with
// a category (`storage_error | too_large | requester_not_admin | internal`), audit
// `export.failed` (actor NULL), and the requester gets the "failed" notice. A storage or
// internal error with a pg-boss retry left puts the row back to `queued` and rethrows, so the
// retry 60 s later starts over; `too_large` / `requester_not_admin` never retry. An admin who
// expires the export while it runs cancels it (partial ZIP deleted, status `expired`).
//
// Logs: ids, counts, bytes, durations and error categories only: never the storage key, a
// signed URL, an email address, a coordinate, a note, a caption or a file name.

/** Photos per metadata / manifest round trip. */
export const EXPORT_PAGE_SIZE = 200;
/** No archive progress for this long ⇒ `storage_error` (stalled read or upload). */
export const EXPORT_STALL_MS = 5 * 60_000;
/** How long a failed export waits for the aborted upload to settle before cleaning up. */
const UPLOAD_SETTLE_MS = 10_000;
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
/** S3 allows 10,000 parts; keep head room for the metadata entries and ZIP overhead. */
const MAX_PARTS_BUDGET = 9_000;

export type ExportStorage = StreamingStorage & Pick<ObjectStorage, "deleteAllVersions">;

export interface DataExportDeps {
  pool: PipelinePool;
  storage: ExportStorage;
  /** `DATA_ENCRYPTION_KEY`: bound only to the transactions that decrypt GPS. */
  dataKey: string;
  /** `EXPORT_MAX_BYTES`: originals above this total fail with `too_large`. */
  maxBytes: number;
  /** null ⇒ no SMTP configured: the outcome is logged with `emailed: false`. */
  mailer: ExportMailer | null;
  log: WorkerLog;
  /** Test hooks. */
  progressEvery?: number;
  pageSize?: number;
  stallMs?: number;
  now?: () => Date;
}

export interface DataExportAttempt {
  /** A pg-boss retry: the row may still be `running` from a dead attempt. */
  retry: boolean;
  /** No retry left: storage/internal errors mark the row failed instead of re-queueing it. */
  lastAttempt: boolean;
}

export type DataExportOutcome =
  | "ready"
  | "failed"
  | "requeued"
  | "cancelled"
  | "skipped"
  | "invalid";

export interface DataExportResult {
  exportId: string | null;
  outcome: DataExportOutcome;
  photos: number;
  bytes: number;
  error?: ExportError;
  emailed?: boolean;
}

/** A failure with a stored category. */
export class ExportFailure extends Error {
  readonly code: ExportError;

  constructor(code: ExportError) {
    super(`export failed: ${code}`);
    this.name = "ExportFailure";
    this.code = code;
  }
}

/** The export was expired by an admin while it ran. */
class ExportCancelled extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelled";
  }
}

/** Category stored in `data_exports.error` for `err`. */
export function exportErrorOf(err: unknown): ExportError {
  if (err instanceof ExportFailure) return err.code;
  if (err instanceof StorageError) return "storage_error";
  return "internal";
}

interface ClaimedExport {
  id: string;
  baby_id: string;
  include_location: boolean;
  storage_key: string;
  expires_at: Date;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Keyset pass over the photo set: the manifest in ZIP order. */
async function loadManifest(
  deps: DataExportDeps,
  babyId: string,
): Promise<{ entries: ManifestEntry[]; totalBytes: number }> {
  const pageSize = deps.pageSize ?? EXPORT_PAGE_SIZE;
  const entries: ManifestEntry[] = [];
  let totalBytes = 0;
  let cursor = { at: "-infinity", id: NIL_UUID };
  for (;;) {
    const rows = await runAsPipeline(deps.pool, {}, async (c) => {
      return (
        await c.query<{
          id: string;
          storage_key_original: string;
          mime: string | null;
          bytes: string;
          entry_date: Date;
          file_date: string;
          sort_key: string;
        }>(MANIFEST_PAGE_SQL, [babyId, cursor.at, cursor.id, pageSize])
      ).rows;
    });
    for (const r of rows) {
      const bytes = Number(r.bytes) || 0;
      totalBytes += bytes;
      entries.push({
        id: r.id,
        storageKey: r.storage_key_original,
        mime: r.mime,
        bytes,
        entryDate: r.entry_date,
        file: originalFileName(r.file_date, r.id, r.mime),
      });
    }
    const last = rows.at(-1);
    if (!last || rows.length < pageSize) break;
    cursor = { at: last.sort_key, id: last.id };
  }
  return { entries, totalBytes };
}

/** Metadata rows of one manifest chunk; decrypts GPS only for a still-admin requester. */
async function loadPhotoRows(
  deps: DataExportDeps,
  exp: ClaimedExport,
  ids: string[],
): Promise<PhotoMetaRow[]> {
  if (!exp.include_location) {
    return runAsPipeline(deps.pool, {}, async (c) => {
      return (await c.query<PhotoMetaRow>(PHOTO_ROWS_SQL, [ids])).rows;
    });
  }
  return runAsPipeline(deps.pool, { dataKey: deps.dataKey }, async (c) => {
    const gate = await c.query<{ ok: boolean }>(REQUESTER_IS_ADMIN_SQL, [exp.id]);
    if (gate.rows[0]?.ok !== true) throw new ExportFailure("requester_not_admin");
    return (await c.query<PhotoMetaRow>(PHOTO_ROWS_WITH_GPS_SQL, [ids])).rows;
  });
}

/**
 * Build and upload the ZIP. Resolves with the archive size; throws `ExportFailure`,
 * `StorageError`, `ExportCancelled` or anything unexpected (⇒ internal).
 */
async function buildZip(
  deps: DataExportDeps,
  exp: ClaimedExport,
  baby: BabyRow,
  members: MemberRow[],
  manifest: { entries: ManifestEntry[]; totalBytes: number },
  abort: AbortController,
): Promise<number> {
  const { log } = deps;
  const pageSize = deps.pageSize ?? EXPORT_PAGE_SIZE;
  const progressEvery = deps.progressEvery ?? EXPORT_PROGRESS_EVERY;
  const exportedAt = (deps.now ?? (() => new Date()))();
  const includeLocation = exp.include_location;

  const archive = new ZipArchive({ zlib: { level: 6 }, forceZip64: true });
  // Part size grows with the album so the upload stays under S3's 10,000-part limit.
  const partSize = Math.max(STREAM_PART_BYTES, Math.ceil(manifest.totalBytes / MAX_PARTS_BUDGET));

  // One rejection source for everything that can go wrong while entries are appended.
  let rejectFailure!: (err: unknown) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => undefined);
  let failed = false;
  const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    rejectFailure(err);
  };
  archive.on("error", (err) => fail(err));
  archive.on("warning", (err) =>
    log.warn({ exportId: exp.id, err: errorCategory(err) }, "export: archive warning"),
  );

  const upload = deps.storage.putObjectStream(exp.storage_key, archive, "application/zip", {
    partSize,
    queueSize: STREAM_QUEUE_SIZE,
    signal: abort.signal,
  });
  upload.catch((err) => fail(err));

  // Stall watchdog: the archive pointer must move.
  let lastPointer = -1;
  let lastMove = Date.now();
  const stallMs = deps.stallMs ?? EXPORT_STALL_MS;
  const watchdog = setInterval(
    () => {
      const p = archive.pointer();
      if (p !== lastPointer) {
        lastPointer = p;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > stallMs) {
        fail(new StorageError("Stalled"));
      }
    },
    Math.min(10_000, Math.max(50, Math.floor(stallMs / 4))),
  );
  watchdog.unref();

  /** Append one entry and wait until archiver has written it (or anything failed). */
  const appendAndWait = (
    source: Readable | Buffer,
    data: { name: string; store?: boolean; date?: Date },
    storageSource = false,
  ): Promise<void> => {
    const written = new Promise<void>((resolve, reject) => {
      const onEntry = (entry: { name?: string }) => {
        if (entry.name !== data.name) return;
        archive.off("entry", onEntry);
        resolve();
      };
      archive.on("entry", onEntry);
      if (source instanceof Readable) {
        source.once("error", (err) => {
          archive.off("entry", onEntry);
          // A broken object read is a storage error (retryable); errors of the generated
          // CSV/JSON streams (database, requester check) keep their own category.
          reject(
            storageSource && !(err instanceof StorageError)
              ? new StorageError(errorCategory(err))
              : err,
          );
        });
      }
    });
    // A late rejection (after `failure` already won the race) must not be unhandled.
    written.catch(() => undefined);
    archive.append(source, data);
    return Promise.race([written, failure]);
  };

  const fileOf = new Map(manifest.entries.map((e) => [e.id, e.file]));
  const milestoneCounts = new Map<string, number>();

  try {
    await appendAndWait(Buffer.from(readmeText({ exportedAt, includeLocation }), "utf8"), {
      name: "README.txt",
      date: exportedAt,
    });

    // photos.csv and photos.json: lazily generated, one database round trip per chunk.
    async function* photoChunks(): AsyncGenerator<{ file: string; row: PhotoMetaRow }[]> {
      for (let i = 0; i < manifest.entries.length; i += pageSize) {
        const chunk = manifest.entries.slice(i, i + pageSize);
        const rows = await loadPhotoRows(
          deps,
          exp,
          chunk.map((e) => e.id),
        );
        yield rows.map((row) => ({ file: fileOf.get(row.id) ?? "", row }));
      }
    }

    async function* photosCsv(): AsyncGenerator<Buffer> {
      yield Buffer.from(CSV_BOM + photosCsvHeader(includeLocation), "utf8");
      for await (const chunk of photoChunks()) {
        let out = "";
        for (const { file, row } of chunk) {
          out += photoCsvRow(file, row, includeLocation);
          if (row.milestone_id) {
            milestoneCounts.set(row.milestone_id, (milestoneCounts.get(row.milestone_id) ?? 0) + 1);
          }
        }
        yield Buffer.from(out, "utf8");
      }
    }
    await appendAndWait(Readable.from(photosCsv(), { objectMode: false }), {
      name: "photos.csv",
      date: exportedAt,
    });

    async function* photosJson(): AsyncGenerator<Buffer> {
      yield Buffer.from("[\n", "utf8");
      let first = true;
      for await (const chunk of photoChunks()) {
        let out = "";
        for (const { file, row } of chunk) {
          out += `${first ? "" : ",\n"}${JSON.stringify(photoJson(file, row, includeLocation))}`;
          first = false;
        }
        if (out) yield Buffer.from(out, "utf8");
      }
      yield Buffer.from("\n]\n", "utf8");
    }
    await appendAndWait(Readable.from(photosJson(), { objectMode: false }), {
      name: "photos.json",
      date: exportedAt,
    });

    const milestoneRows = await runAsPipeline(deps.pool, {}, async (c) => {
      return (await c.query<MilestoneRow>(MILESTONES_SQL, [exp.baby_id])).rows;
    });
    const milestones = milestoneCsvRows(milestoneRows, milestoneCounts);
    await appendAndWait(
      Buffer.from(CSV_BOM + csvHeader(MILESTONES_CSV_COLUMNS) + milestones.csv, "utf8"),
      { name: "milestones.csv", date: exportedAt },
    );

    let measurementCount = 0;
    async function* measurementsCsv(): AsyncGenerator<Buffer> {
      yield Buffer.from(CSV_BOM + csvHeader(MEASUREMENTS_CSV_COLUMNS), "utf8");
      let cursor = { at: "-infinity", id: NIL_UUID };
      for (;;) {
        const rows = await runAsPipeline(deps.pool, {}, async (c) => {
          return (
            await c.query<MeasurementRow>(MEASUREMENTS_PAGE_SQL, [
              exp.baby_id,
              cursor.at,
              cursor.id,
              pageSize,
            ])
          ).rows;
        });
        let out = "";
        for (const r of rows) out += measurementCsvRow(r, (id) => fileOf.get(id));
        measurementCount += rows.length;
        if (out) yield Buffer.from(out, "utf8");
        const last = rows.at(-1);
        if (!last || rows.length < pageSize) break;
        cursor = { at: last.cursor_at, id: last.id };
      }
    }
    await appendAndWait(Readable.from(measurementsCsv(), { objectMode: false }), {
      name: "measurements.csv",
      date: exportedAt,
    });

    await appendAndWait(
      Buffer.from(
        albumJson({
          exportedAt,
          includeLocation,
          baby,
          members,
          counts: {
            photos: manifest.entries.length,
            milestones: milestones.count,
            measurements: measurementCount,
          },
        }),
        "utf8",
      ),
      { name: "album.json", date: exportedAt },
    );

    // Originals: stored (already compressed), one stream at a time.
    let done = 0;
    for (const entry of manifest.entries) {
      const source = await Promise.race([deps.storage.getObjectStream(entry.storageKey), failure]);
      await appendAndWait(source, { name: entry.file, store: true, date: entry.entryDate }, true);
      done++;
      if (done % progressEvery === 0 && done < manifest.entries.length) {
        const live = await runAsPipeline(deps.pool, {}, async (c) => {
          return (await c.query<{ live: boolean }>(PROGRESS_SQL, [exp.id, done])).rows[0]?.live;
        });
        if (live !== true) throw new ExportCancelled();
      }
    }

    await Promise.race([archive.finalize(), failure]);
    await Promise.race([upload, failure]);
    return archive.pointer();
  } catch (err) {
    abort.abort();
    archive.abort();
    archive.destroy();
    // The aborted upload settles promptly (lib-storage rejects `done()`); never wait forever.
    await Promise.race([upload.catch(() => undefined), delay(UPLOAD_SETTLE_MS)]);
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

async function notify(
  deps: DataExportDeps,
  exportId: string,
  send: (mailer: ExportMailer, to: string) => Promise<void>,
): Promise<boolean> {
  if (!deps.mailer) {
    deps.log.info({ exportId, emailed: false, reason: "smtp_unconfigured" }, "export: no email");
    return false;
  }
  try {
    const to = await runAsPipeline(deps.pool, {}, async (c) => {
      return (await c.query<{ email: string | null }>(REQUESTER_EMAIL_SQL, [exportId])).rows[0]
        ?.email;
    });
    if (!to) {
      deps.log.info({ exportId, emailed: false }, "export: no email (requester not eligible)");
      return false;
    }
    await send(deps.mailer, to);
    return true;
  } catch (err) {
    deps.log.warn({ exportId, emailed: false, err: errorCategory(err) }, "export: email failed");
    return false;
  }
}

/** Delete every version of the export object; never throws (the sweep retries). */
async function deleteZip(deps: DataExportDeps, exp: ClaimedExport): Promise<void> {
  try {
    await deps.storage.deleteAllVersions(exp.storage_key);
  } catch (err) {
    deps.log.warn(
      { exportId: exp.id, err: errorCategory(err) },
      "export: could not delete partial ZIP (purge.trash retries)",
    );
  }
}

/**
 * Run one export. Never throws for an outcome the row records (`failed`, `cancelled`); throws
 * (after re-queueing the row) only for a storage/internal error with a retry left, and rethrows
 * a storage/internal error on the last attempt after recording it, so pg-boss marks the job failed.
 */
export async function runDataExport(
  deps: DataExportDeps,
  job: DataExportJob,
  attempt: DataExportAttempt = { retry: false, lastAttempt: true },
): Promise<DataExportResult> {
  const { pool, log } = deps;
  const started = Date.now();
  const claimed = await runAsPipeline(pool, {}, async (c) => {
    const res = await c.query<ClaimedExport>(CLAIM_EXPORT_SQL, [
      job.exportId,
      job.babyId,
      attempt.retry,
    ]);
    if (res.rows[0]) return res.rows[0];
    await c.query(CANCEL_QUEUED_EXPORT_SQL, [job.exportId]);
    return null;
  });
  if (!claimed) {
    log.info({ exportId: job.exportId }, "export: nothing to do (not queued)");
    return { exportId: job.exportId, outcome: "skipped", photos: 0, bytes: 0 };
  }
  const exp = claimed;
  log.info(
    {
      exportId: exp.id,
      babyId: exp.baby_id,
      includeLocation: exp.include_location,
      retry: attempt.retry,
    },
    "export: started",
  );

  const abort = new AbortController();
  let photos = 0;
  try {
    const { baby, members, isAdmin } = await runAsPipeline(pool, {}, async (c) => {
      const gate = await c.query<{ ok: boolean }>(REQUESTER_IS_ADMIN_SQL, [exp.id]);
      const b = await c.query<BabyRow>(BABY_SQL, [exp.baby_id]);
      const m = await c.query<MemberRow>(MEMBERS_SQL, [exp.baby_id]);
      return { baby: b.rows[0], members: m.rows, isAdmin: gate.rows[0]?.ok === true };
    });
    if (!isAdmin) throw new ExportFailure("requester_not_admin");
    if (!baby) throw new ExportFailure("internal");

    const manifest = await loadManifest(deps, exp.baby_id);
    photos = manifest.entries.length;
    if (manifest.totalBytes > deps.maxBytes) throw new ExportFailure("too_large");
    await runAsPipeline(pool, {}, async (c) => {
      await c.query(SET_PHOTO_COUNT_SQL, [exp.id, photos]);
    });

    const bytes = await buildZip(deps, exp, baby, members, manifest, abort);

    const ready = await runAsPipeline(pool, {}, async (c) => {
      const res = await c.query<{ expires_at: Date }>(MARK_READY_SQL, [exp.id, bytes, photos]);
      const row = res.rows[0];
      if (row) {
        await c.query(AUDIT_EXPORT_SQL, [
          exp.baby_id,
          "export.ready",
          JSON.stringify({ export_id: exp.id, count: photos }),
        ]);
      }
      return row ?? null;
    });
    if (!ready) throw new ExportCancelled();

    const emailed = await notify(deps, exp.id, (mailer, to) =>
      mailer.sendExportReady(to, { babyName: baby.name, expiresAt: ready.expires_at }),
    );
    log.info(
      {
        exportId: exp.id,
        babyId: exp.baby_id,
        photos,
        bytes,
        durationMs: Date.now() - started,
        emailed,
      },
      "export: ready",
    );
    return { exportId: exp.id, outcome: "ready", photos, bytes, emailed };
  } catch (err) {
    abort.abort();
    await deleteZip(deps, exp);

    if (err instanceof ExportCancelled) {
      await runAsPipeline(pool, {}, async (c) => {
        await c.query(MARK_CANCELLED_SQL, [exp.id]);
      });
      log.info(
        { exportId: exp.id, photos, durationMs: Date.now() - started },
        "export: cancelled (expired by an admin)",
      );
      return { exportId: exp.id, outcome: "cancelled", photos, bytes: 0 };
    }

    const code = exportErrorOf(err);
    const retryable = RETRYABLE_EXPORT_ERRORS.includes(code);
    if (retryable && !attempt.lastAttempt) {
      await runAsPipeline(pool, {}, async (c) => {
        await c.query(REQUEUE_SQL, [exp.id]);
      });
      log.warn(
        {
          exportId: exp.id,
          error: code,
          err: errorCategory(err),
          durationMs: Date.now() - started,
        },
        "export: attempt failed, retrying",
      );
      throw err;
    }

    const marked = await runAsPipeline(pool, {}, async (c) => {
      const n = (await c.query(MARK_FAILED_SQL, [exp.id, code])).rowCount ?? 0;
      if (n > 0) {
        await c.query(AUDIT_EXPORT_SQL, [
          exp.baby_id,
          "export.failed",
          JSON.stringify({ export_id: exp.id }),
        ]);
      }
      return n > 0;
    });
    const babyName = await runAsPipeline(pool, {}, async (c) => {
      return (await c.query<BabyRow>(BABY_SQL, [exp.baby_id])).rows[0]?.name ?? "";
    }).catch(() => "");
    const emailed = marked
      ? await notify(deps, exp.id, (mailer, to) =>
          mailer.sendExportFailed(to, { babyName, error: code }),
        )
      : false;
    log.warn(
      {
        exportId: exp.id,
        error: code,
        err: errorCategory(err),
        photos,
        durationMs: Date.now() - started,
        emailed,
      },
      "export: failed",
    );
    if (retryable) throw err;
    return { exportId: exp.id, outcome: "failed", photos, bytes: 0, error: code, emailed };
  }
}

/** pg-boss job shape the handler reads (`includeMetadata: true`). */
export interface DataExportJobLike {
  id: string;
  data: unknown;
  retryCount?: number;
  retryLimit?: number;
}

/**
 * `data.export` handler. A malformed payload can never succeed: logged (job id only) and dropped.
 */
export async function handleDataExportJob(
  deps: DataExportDeps,
  job: DataExportJobLike,
): Promise<DataExportResult> {
  const parsed = dataExportJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "data.export: invalid job payload, dropped");
    return { exportId: null, outcome: "invalid", photos: 0, bytes: 0 };
  }
  const retryCount = job.retryCount ?? 0;
  const retryLimit = job.retryLimit ?? 0;
  return runDataExport(deps, parsed.data, {
    retry: retryCount > 0,
    lastAttempt: retryCount >= retryLimit,
  });
}

/** Categories that re-queue the export while a pg-boss retry is left. */
export const RETRYABLE_EXPORT_ERRORS: readonly ExportError[] = Object.freeze([
  "storage_error",
  "internal",
]);
