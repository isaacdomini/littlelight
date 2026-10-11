import { createReadStream } from "node:fs";
import {
  ACCEPTED_UPLOAD_MIMES,
  type AuditEvent,
  auditMetadataSchema,
  IMPORT_BATCH_MAX_ITEMS,
  type ImportBatchError,
  type ImportGoogleJob,
  type ImportItemError,
  type IngestJob,
  importGoogleJobSchema,
  ingestJobSchema,
  type PhotoMime,
  type PickerMediaItem,
} from "@tinyglow/shared";
import type { JobWithMetadata } from "pg-boss";
import { errorCategory } from "../../clients";
import { type PipelinePool, runAsPipeline } from "../../db";
import { sniffPhotoMime } from "../../ingest/sniff";
import type { WorkerLog } from "../../log-types";
import type { WorkerStorage } from "../../storage";
import {
  AUDIT_SQL,
  BOOK_PHOTO_SQL,
  CANCEL_REQUESTED_SQL,
  CLAIM_BATCH_SQL,
  DUPLICATE_PRECHECK_SQL,
  FINISH_BATCH_SQL,
  INSERT_ITEMS_SQL,
  LIST_ITEMS_SQL,
  LOAD_BATCH_SQL,
  MARK_DOWNLOADED_SQL,
  MARK_ITEM_SQL,
  MARK_PENDING_SQL,
  MARK_RECONNECT_SQL,
  RECOUNT_SQL,
  REFRESH_TOKEN_SQL,
  REQUESTER_STATE_SQL,
  SET_TOTAL_SQL,
} from "../sql";
import {
  type GoogleError,
  isGoogleError,
  isTransientGoogleError,
  type WorkerGoogleClient,
} from "./client";
import {
  type AccessTokenSource,
  type DownloadDeps,
  DownloadError,
  type DownloadedFile,
  downloadMedia,
  removeStaged,
} from "./download";

// `import.google` (docs/plans/step-10.md 2.7, D6, D8, D10, D11, D20): one Google Picker batch.
//
//   requester state → claim (`running`) → refresh token (`import_google_refresh_token`, data key
//   bound to that one transaction) → access token in memory → list the session's items (paged) →
//   `import_items` → per item, `IMPORT_CONCURRENCY` at a time: guarded download to /tmp (sha256,
//   size cap) → sniff → duplicate pre-check → `downloaded` → PUT the original → `import_book_photo`
//   → `photo.ingest` → finish (`done | failed | cancelled`), delete the Picker session, audit.
//
// Runs as `pipeline`. No model call and no embedding call: booked photos follow the normal
// ingest → reindex path, whose paid-tier gate is unchanged (free-tier photos are never sent to a
// model). Videos and anything outside the five accepted photo types are skipped (v1 is photos
// only). The worker never inserts into `photos` (D10) and never reads `google_accounts`.
//
// Idempotent: a retried job re-claims its `running` batch, re-lists the session (`baseUrl`s live
// in memory for one run only), keeps the outcomes of items already booked/duplicate/failed/skipped
// and re-processes `pending`/`downloaded` ones (the object key is fixed per item). Only storage,
// network and database trouble is rethrown for a pg-boss retry; on the last attempt the batch
// fails instead. Logs: ids, counts, byte sizes, durations and categories only; never a token, a
// `baseUrl`, a `pickerUri`, a session or item id of Google, or a file name.

/** The batch outcome. `skipped`: nothing to do (not active, wrong baby, already claimed). */
export type ImportGoogleOutcome = "done" | "failed" | "cancelled" | "skipped";

export interface ImportGoogleResult {
  outcome: ImportGoogleOutcome;
  batchId: string;
  error?: ImportBatchError;
  total?: number;
  imported?: number;
  duplicates?: number;
  failed?: number;
  skipped?: number;
  ms: number;
}

export interface ImportGoogleDeps {
  pool: PipelinePool;
  storage: Pick<WorkerStorage, "putObjectStream" | "deleteAllVersions">;
  /** `DATA_ENCRYPTION_KEY`: bound only to the refresh-token transaction. Never logged. */
  dataKey: string;
  /** `null` when `GOOGLE_IMPORT_PROVIDER=none`: a stray batch fails `internal`. */
  google: WorkerGoogleClient | null;
  /** Download guard settings (allow-list, size cap, staging dir). */
  download: DownloadDeps;
  /** `IMPORT_CONCURRENCY`: downloads in flight per batch. */
  concurrency: number;
  /** Items taken per batch (default `IMPORT_BATCH_MAX_ITEMS`, D11). */
  maxItems?: number;
  /** Enqueues `photo.ingest` for a booked photo (null = one is already queued). */
  sendIngest: (job: IngestJob) => Promise<string | null>;
  log: WorkerLog;
}

export interface RunOptions {
  /** No pg-boss retry left: transient trouble fails the batch instead of rethrowing. */
  lastAttempt: boolean;
}

/** Thrown for a pg-boss retry (storage / network / database trouble). Category only. */
export class ImportRetryError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`import retry: ${category}`);
    this.name = "ImportRetryError";
    this.category = category;
  }
}

/** Most Picker pages read per batch (a session holds at most a few thousand items). */
export const MAX_LIST_PAGES = 100;

interface BatchRow {
  id: string;
  baby_id: string;
  status: string;
  provider_session_id: string | null;
  tz_hint: string | null;
  cancel_requested_at: Date | null;
}

interface ItemRow {
  id: string;
  provider_item_id: string;
  status: string;
  storage_key: string;
}

/** Why the item loop stopped early. */
type Stop =
  | { kind: "cancel" }
  /**
   * A cap refused the booking: the family's free pool (`free_tier_limit`) or, for a guest, their
   * pending queue in this family (`pending_limit`, step 11). Either way the run stops as `done`
   * and the untouched items are marked with that error.
   */
  | { kind: "cap"; itemError: "free_tier_limit" | "pending_limit" }
  | { kind: "reconnect" }
  | { kind: "fail"; error: ImportBatchError; itemError: ImportItemError }
  | { kind: "transient"; category: string };

const ACCEPTED = new Set<string>(ACCEPTED_UPLOAD_MIMES);
const INT_MAX = 2_147_483_647;

/** Requester state ⇒ batch error (`null` for `ok`, `"skip"` for `not_active`). */
export function stateError(state: string): ImportBatchError | "skip" | null {
  switch (state) {
    case "ok":
      return null;
    case "not_active":
      return "skip";
    case "baby_trashed":
      return "baby_trashed";
    case "not_connected":
    case "reconnect":
      return "google_reconnect";
    default:
      return "requester_not_member";
  }
}

/** The Picker item as an `import_items` row: accepted photo ⇒ `pending`, else `skipped`. */
export function classifyItem(item: PickerMediaItem): {
  mime: PhotoMime | null;
  width: number | null;
  height: number | null;
  status: "pending" | "skipped";
  error: ImportItemError | null;
} {
  const mime = item.mediaFile.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const dim = (v: number | undefined) =>
    typeof v === "number" && Number.isInteger(v) && v > 0 && v <= INT_MAX ? v : null;
  const width = dim(item.mediaFile.mediaFileMetadata?.width);
  const height = dim(item.mediaFile.mediaFileMetadata?.height);
  if (item.type !== "PHOTO" || !ACCEPTED.has(mime)) {
    return { mime: null, width, height, status: "skipped", error: "unsupported_media_type" };
  }
  return { mime: mime as PhotoMime, width, height, status: "pending", error: null };
}

/** `photo.ingest` payload with the batch's time zone when it is a valid one. */
export function ingestPayload(photoId: string, babyId: string, tzHint: string | null): IngestJob {
  if (tzHint) {
    const withTz = ingestJobSchema.safeParse({ photoId, babyId, tzHint });
    if (withTz.success) return withTz.data;
  }
  return ingestJobSchema.parse({ photoId, babyId });
}

/** Single-flight access token holder (the token never leaves this closure but for requests). */
export function createTokenSource(mint: () => Promise<string>, first: string): AccessTokenSource {
  let current = first;
  let inflight: Promise<string> | null = null;
  return {
    get: async () => current,
    refresh: async (stale) => {
      if (stale !== current) return current;
      inflight ??= mint()
        .then((t) => {
          current = t;
          return t;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/** `pg-boss` handler for one job (payload parse, attempt bookkeeping). */
export async function handleImportGoogleJob(
  deps: ImportGoogleDeps,
  job: Pick<JobWithMetadata<unknown>, "id" | "data" | "retryCount" | "retryLimit">,
): Promise<ImportGoogleResult | null> {
  const parsed = importGoogleJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.warn({ jobId: job.id }, "import.google: invalid job payload, dropped");
    return null;
  }
  const lastAttempt = job.retryCount >= job.retryLimit;
  try {
    return await runImportGoogle(deps, parsed.data, { lastAttempt });
  } catch (err) {
    deps.log.warn(
      {
        batchId: parsed.data.batchId,
        attempt: job.retryCount + 1,
        category: err instanceof ImportRetryError ? err.category : errorCategory(err),
        giveUp: lastAttempt,
      },
      "import.google: attempt failed",
    );
    throw err;
  }
}

/** Run one batch (exported for run-job and tests). */
export async function runImportGoogle(
  deps: ImportGoogleDeps,
  job: ImportGoogleJob,
  opts: RunOptions,
): Promise<ImportGoogleResult> {
  const started = Date.now();
  const { pool, log } = deps;
  const { batchId, babyId } = job;
  const ms = () => Date.now() - started;
  const q = <R extends object>(sql: string, values: unknown[]) =>
    runAsPipeline(
      pool,
      {},
      async (c) => (await c.query<R & Record<string, unknown>>(sql, values)).rows,
    );

  const batch = (await q<BatchRow>(LOAD_BATCH_SQL, [batchId]))[0];
  if (!batch || batch.baby_id !== babyId) {
    log.warn({ batchId }, "import.google: no such batch for this baby, dropped");
    return { outcome: "skipped", batchId, ms: ms() };
  }
  if (batch.status !== "queued" && batch.status !== "running") {
    log.info({ batchId, status: batch.status }, "import.google: batch not active, skipped");
    return { outcome: "skipped", batchId, ms: ms() };
  }

  // --- helpers that finish the batch -----------------------------------------------------------
  let tokens: AccessTokenSource | null = null;
  const sessionId = batch.provider_session_id;
  const tzHint = batch.tz_hint;

  async function deleteSession(): Promise<void> {
    if (!deps.google || !tokens || !sessionId) return;
    const ok = await deps.google.deleteSession(await tokens.get(), sessionId).catch(() => false);
    if (!ok) log.info({ batchId }, "import.google: picker session not deleted (best effort)");
  }

  async function finish(
    status: "done" | "failed" | "cancelled",
    error: ImportBatchError | null,
    overflow = 0,
  ): Promise<ImportGoogleResult> {
    const row = await runAsPipeline(pool, {}, async (c) => {
      await c.query(RECOUNT_SQL, [batchId, overflow]);
      const res = await c.query<{
        baby_id: string;
        items_imported: number;
        items_duplicate: number;
        items_failed: number;
        items_skipped: number;
      }>(FINISH_BATCH_SQL, [batchId, status, error]);
      const r = res.rows[0];
      if (r && status !== "cancelled") {
        // `import.batch_cancelled` is audited by the api when the requester asks (actor set).
        const event: AuditEvent =
          status === "done" ? "import.batch_finished" : "import.batch_failed";
        const metadata = auditMetadataSchema.parse(
          status === "done"
            ? {
                batch_id: batchId,
                count: r.items_imported,
                duplicates: r.items_duplicate,
                failed: r.items_failed,
              }
            : { batch_id: batchId },
        );
        await c.query(AUDIT_SQL, [r.baby_id, event, JSON.stringify(metadata)]);
      }
      return r;
    });
    await deleteSession();
    const result: ImportGoogleResult = {
      outcome: row ? status : "skipped",
      batchId,
      ...(error ? { error } : {}),
      ...(row
        ? {
            imported: row.items_imported,
            duplicates: row.items_duplicate,
            failed: row.items_failed,
            skipped: row.items_skipped,
          }
        : {}),
      ms: ms(),
    };
    log.info(
      {
        batchId,
        babyId,
        outcome: result.outcome,
        category: error ?? undefined,
        imported: result.imported,
        duplicates: result.duplicates,
        failed: result.failed,
        skipped: result.skipped,
        ms: result.ms,
      },
      "import.google: batch finished",
    );
    return result;
  }

  /** Transient trouble: rethrow for a retry, or fail the batch on the last attempt. */
  async function transient(category: string, overflow = 0): Promise<ImportGoogleResult> {
    if (!opts.lastAttempt) throw new ImportRetryError(category);
    return finish("failed", category === "storage_error" ? "storage_error" : "internal", overflow);
  }

  // --- 1. requester state, cancel, claim ---------------------------------------------------------
  if (batch.cancel_requested_at) return finish("cancelled", null);
  const state = (await q<{ state: string }>(REQUESTER_STATE_SQL, [batchId]))[0]?.state ?? "";
  const stateErr = stateError(state);
  if (stateErr === "skip") return { outcome: "skipped", batchId, ms: ms() };
  if (stateErr) return finish("failed", stateErr);
  if (!deps.google) {
    log.warn({ batchId, category: "provider_none" }, "import.google: provider not configured");
    return finish("failed", "internal");
  }
  if (!sessionId) return finish("failed", "internal");
  const google = deps.google;
  const claimed = await q<{ id: string }>(CLAIM_BATCH_SQL, [batchId, babyId]);
  if (claimed.length === 0) return { outcome: "skipped", batchId, ms: ms() };

  // --- 2. tokens ----------------------------------------------------------------------------------
  const refreshToken = await runAsPipeline(pool, { dataKey: deps.dataKey }, async (c) => {
    const res = await c.query<{ token: string | null }>(REFRESH_TOKEN_SQL, [batchId]);
    return res.rows[0]?.token ?? null;
  });
  if (!refreshToken) {
    const again = stateError(
      (await q<{ state: string }>(REQUESTER_STATE_SQL, [batchId]))[0]?.state ?? "",
    );
    return finish("failed", again && again !== "skip" ? again : "google_reconnect");
  }
  const mint = () => google.refreshAccessToken(refreshToken);

  async function onTokenError(err: unknown): Promise<ImportGoogleResult> {
    if (isGoogleError(err) && err.category === "google_reconnect") {
      await q(MARK_RECONNECT_SQL, [batchId]);
      return finish("failed", "google_reconnect");
    }
    if (isTransientGoogleError(err)) return transient(`google_${(err as GoogleError).category}`);
    return finish(
      "failed",
      isGoogleError(err) && err.category === "google_denied" ? "google_denied" : "internal",
    );
  }

  let first: string;
  try {
    first = await mint();
  } catch (err) {
    return onTokenError(err);
  }
  tokens = createTokenSource(mint, first);

  // --- 3. list the picked items -------------------------------------------------------------------
  const maxItems = Math.max(0, deps.maxItems ?? IMPORT_BATCH_MAX_ITEMS);
  const taken: PickerMediaItem[] = [];
  const seen = new Set<string>();
  let overflow = 0;
  try {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await google.listMediaItems(await tokens.get(), sessionId, pageToken);
      for (const item of res.mediaItems) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (taken.length < maxItems) taken.push(item);
        else overflow++;
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
  } catch (err) {
    if (isGoogleError(err)) {
      if (err.category === "not_found") return finish("failed", "session_expired");
      if (err.category === "google_denied") return finish("failed", "google_denied");
      if (isTransientGoogleError(err)) return transient(`google_${err.category}`);
    }
    return finish("failed", "internal");
  }

  // `baseUrl`s stay in this map, in memory, for this run only.
  const baseUrls = new Map<string, string>();
  const cols = {
    pid: [] as string[],
    mime: [] as (string | null)[],
    w: [] as (number | null)[],
    h: [] as (number | null)[],
    ts: [] as string[],
    status: [] as string[],
    err: [] as (string | null)[],
  };
  let unsupported = 0;
  for (const item of taken) {
    const c = classifyItem(item);
    if (c.status === "pending") baseUrls.set(item.id, item.mediaFile.baseUrl);
    else unsupported++;
    cols.pid.push(item.id);
    cols.mime.push(c.mime);
    cols.w.push(c.width);
    cols.h.push(c.height);
    cols.ts.push(item.createTime);
    cols.status.push(c.status);
    cols.err.push(c.error);
  }
  const items = await runAsPipeline(pool, {}, async (c) => {
    if (cols.pid.length > 0) {
      await c.query(INSERT_ITEMS_SQL, [
        batchId,
        babyId,
        cols.pid,
        cols.mime,
        cols.w,
        cols.h,
        cols.ts,
        cols.status,
        cols.err,
      ]);
    }
    await c.query(SET_TOTAL_SQL, [batchId, taken.length + overflow]);
    await c.query(RECOUNT_SQL, [batchId, overflow]);
    return (await c.query<ItemRow>(LIST_ITEMS_SQL, [batchId])).rows;
  });
  log.info(
    { batchId, babyId, count: taken.length, skipped: unsupported, overflow },
    "import.google: items listed",
  );
  if (taken.length === 0 && overflow > 0) return finish("failed", "too_many_items", overflow);

  // --- 4. download, store, book -------------------------------------------------------------------
  const open = items.filter((i) => i.status === "pending" || i.status === "downloaded");
  let stop: Stop | null = null;
  const setStop = (s: Stop) => {
    stop ??= s;
  };

  const markItem = (id: string, status: string, error: ImportItemError | null) =>
    q(MARK_ITEM_SQL, [id, status, error]);

  async function dropObject(key: string, itemId: string): Promise<void> {
    await deps.storage.deleteAllVersions(key).catch((err: unknown) => {
      // The item stays `downloaded` only on the PUT path; here it is marked, and the object is an
      // orphan the sweep cannot see: log the category so an operator can find it.
      log.warn(
        { batchId, itemId, category: errorCategory(err) },
        "import.google: object delete failed",
      );
    });
  }

  async function processItem(item: ItemRow): Promise<void> {
    const itemStarted = Date.now();
    const baseUrl = baseUrls.get(item.provider_item_id);
    if (!baseUrl) {
      // A row from an earlier attempt that this listing no longer returns.
      await markItem(item.id, "failed", "download_failed");
      return;
    }
    let file: DownloadedFile | undefined;
    try {
      try {
        file = await downloadMedia(deps.download, tokens as AccessTokenSource, item.id, baseUrl);
      } catch (err) {
        if (isGoogleError(err) && err.category === "google_reconnect") {
          setStop({ kind: "reconnect" });
          return;
        }
        const category = err instanceof DownloadError ? err.category : "network";
        const status = err instanceof DownloadError ? err.status : undefined;
        log.info({ batchId, itemId: item.id, category, status }, "import.google: download failed");
        await markItem(
          item.id,
          "failed",
          category === "file_too_large" ? "file_too_large" : "download_failed",
        );
        return;
      }
      const mime = await sniffPhotoMime(file.head);
      if (!mime) {
        await markItem(item.id, "skipped", "unsupported_media_type");
        return;
      }
      const dup = await q(DUPLICATE_PRECHECK_SQL, [babyId, file.sha256]);
      if (dup.length > 0) {
        await markItem(item.id, "duplicate", null);
        return;
      }
      await q(MARK_DOWNLOADED_SQL, [item.id, file.bytes, file.sha256, mime]);
      try {
        await deps.storage.putObjectStream(item.storage_key, createReadStream(file.path), mime);
      } catch (err) {
        // The item stays `downloaded`: a retry re-processes it, the sweep cleans it otherwise.
        setStop({ kind: "transient", category: "storage_error" });
        log.warn(
          { batchId, itemId: item.id, category: errorCategory(err) },
          "import.google: store failed",
        );
        return;
      }
      const outcome = (await q<{ outcome: string }>(BOOK_PHOTO_SQL, [item.id]))[0]?.outcome;
      switch (outcome) {
        case "booked":
          await deps.sendIngest(ingestPayload(item.id, babyId, tzHint)).catch((err: unknown) =>
            // `ingest.reconcile` re-sends photos stuck in `uploaded`.
            log.warn(
              { batchId, itemId: item.id, category: errorCategory(err) },
              "import.google: ingest send failed",
            ),
          );
          break;
        case "duplicate":
          await dropObject(item.storage_key, item.id);
          await markItem(item.id, "duplicate", null);
          break;
        case "free_tier_limit":
        case "pending_limit":
          await dropObject(item.storage_key, item.id);
          await markItem(item.id, "failed", outcome);
          setStop({ kind: "cap", itemError: outcome });
          break;
        case "not_member":
          await dropObject(item.storage_key, item.id);
          await markItem(item.id, "failed", "not_member");
          setStop({ kind: "fail", error: "requester_not_member", itemError: "not_member" });
          break;
        case "baby_trashed":
          await dropObject(item.storage_key, item.id);
          await markItem(item.id, "failed", "baby_trashed");
          setStop({ kind: "fail", error: "baby_trashed", itemError: "baby_trashed" });
          break;
        default:
          setStop({ kind: "transient", category: "internal" });
          return;
      }
      log.debug(
        {
          batchId,
          itemId: item.id,
          category: outcome,
          bytes: file.bytes,
          ms: Date.now() - itemStarted,
        },
        "import.google: item done",
      );
    } finally {
      if (file) await removeStaged(file.path);
    }
  }

  let next = 0;
  async function lane(): Promise<void> {
    while (stop === null) {
      const item = open[next++];
      if (!item) return;
      try {
        const row = (
          await q<{ cancel: boolean; status: string }>(CANCEL_REQUESTED_SQL, [batchId])
        )[0];
        if (!row || row.cancel || row.status !== "running") {
          setStop({ kind: "cancel" });
          return;
        }
        await processItem(item);
        await q(RECOUNT_SQL, [batchId, overflow]);
      } catch (err) {
        // Database trouble: stop; a retry re-processes the open items.
        setStop({
          kind: "transient",
          category: errorCategory(err) === "error" ? "internal" : "database",
        });
        log.warn(
          { batchId, itemId: item.id, category: errorCategory(err) },
          "import.google: item error",
        );
      }
    }
  }
  const lanes = Math.max(1, Math.min(deps.concurrency, open.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));

  // --- 5. finish ----------------------------------------------------------------------------------
  const s = stop as Stop | null;
  if (s === null) return finish("done", null, overflow);
  switch (s.kind) {
    case "cancel":
      return finish("cancelled", null, overflow);
    case "cap":
      await q(MARK_PENDING_SQL, [batchId, s.itemError]);
      return finish("done", null, overflow);
    case "reconnect":
      await q(MARK_RECONNECT_SQL, [batchId]);
      return finish("failed", "google_reconnect", overflow);
    case "fail":
      await q(MARK_PENDING_SQL, [batchId, s.itemError]);
      return finish("failed", s.error, overflow);
    case "transient":
      if (opts.lastAttempt) await q(MARK_PENDING_SQL, [batchId, "storage_error"]);
      return transient(s.category, overflow);
  }
}
