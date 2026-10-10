import {
  IMPORT_SOURCES_LIST_MAX,
  type ImportBatch,
  type ImportBatchError,
  type ImportBatchStatus,
  type ImportSource,
  type ImportSourceError,
  type ImportSourceKind,
  importBatchSchema,
  importSourceSchema,
  type PatchImportSourceRequest,
  type SyncTrigger,
  type UpsertImportSourceRequest,
} from "@tinyglow/shared";
import type { Tx } from "../auth";

// `import_sources` / `import_batches` / `google_accounts` reads and writes under the caller's
// claims (docs/plans/step-10.md 2.2, 2.6). RLS is the authorization; the role checks in the
// routes only pick the message. Every statement names its columns: `provider_session_id` is not
// granted to `authenticated` (never `SELECT *` / `RETURNING *` on `import_batches`), and
// `refresh_token_enc` is not either (`google_accounts`: four granted columns). Owner / requester
// names come from `member_profiles` (co-member display names only).

// ---------------------------------------------------------------------------------------------
// import_sources (Apple album sync)
// ---------------------------------------------------------------------------------------------

const SOURCE_COLUMNS = `
  s.id, s.baby_id, s.user_id, s.kind, s.device_id, s.device_label, s.album_title, s.wifi_only,
  s.paused, s.last_sync_at, s.last_trigger, s.imported_count, s.duplicate_count, s.failed_count,
  s.skipped_count, s.last_error, s.created_at`;

export interface SourceRow {
  id: string;
  baby_id: string;
  user_id: string;
  user_name: string | null;
  kind: ImportSourceKind;
  device_id: string;
  device_label: string;
  album_title: string;
  wifi_only: boolean;
  paused: boolean;
  last_sync_at: Date | null;
  last_trigger: SyncTrigger | null;
  imported_count: number;
  duplicate_count: number;
  failed_count: number;
  skipped_count: number;
  last_error: ImportSourceError | null;
  created_at: Date;
}

/** Row → wire DTO (strict schema: an extra field fails closed). */
export function toImportSource(r: SourceRow, uid: string, deviceId?: string | null): ImportSource {
  return importSourceSchema.parse({
    id: r.id,
    babyId: r.baby_id,
    userId: r.user_id,
    userName: r.user_name,
    kind: r.kind,
    deviceId: r.device_id,
    deviceLabel: r.device_label,
    albumTitle: r.album_title,
    wifiOnly: r.wifi_only,
    paused: r.paused,
    isMine: r.user_id === uid,
    isThisDevice: typeof deviceId === "string" && r.device_id === deviceId.toLowerCase(),
    lastSyncAt: r.last_sync_at?.toISOString() ?? null,
    lastTrigger: r.last_trigger,
    importedCount: r.imported_count,
    duplicateCount: r.duplicate_count,
    failedCount: r.failed_count,
    skippedCount: r.skipped_count,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
  });
}

/** Sync rows of a baby visible to the caller (admins: every device; others: their own). */
export async function listSources(client: Tx, babyId: string): Promise<SourceRow[]> {
  const { rows } = await client.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}, mp.display_name AS user_name
       FROM public.import_sources s
       LEFT JOIN public.member_profiles mp ON mp.user_id = s.user_id
      WHERE s.baby_id = $1
      ORDER BY s.created_at, s.id
      LIMIT ${IMPORT_SOURCES_LIST_MAX}`,
    [babyId],
  );
  return rows;
}

async function sourceById(client: Tx, id: string): Promise<SourceRow | null> {
  const { rows } = await client.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}, mp.display_name AS user_name
       FROM public.import_sources s
       LEFT JOIN public.member_profiles mp ON mp.user_id = s.user_id
      WHERE s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Upsert the caller's sync row for `(deviceId, babyId, kind)`. The `DO UPDATE ... WHERE user_id =
 * auth_uid()` runs before the RLS conflict check, so another user's row yields 0 rows (`null`,
 * the route's 409 `import_source_exists`) instead of an RLS error. Re-enabling un-pauses and
 * clears the last error. A contributor fails the INSERT policy (42501 ⇒ 403).
 */
export async function upsertSource(
  client: Tx,
  babyId: string,
  body: UpsertImportSourceRequest,
): Promise<{ row: SourceRow; inserted: boolean } | null> {
  const { rows } = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO public.import_sources AS s
            (baby_id, user_id, kind, device_id, device_label, album_title, wifi_only)
     VALUES ($1, public.auth_uid(), $2, $3, $4, $5, $6)
     ON CONFLICT (device_id, baby_id, kind) DO UPDATE
        SET device_label = EXCLUDED.device_label,
            album_title = EXCLUDED.album_title,
            wifi_only = EXCLUDED.wifi_only,
            paused = false,
            last_error = NULL
      WHERE s.user_id = public.auth_uid()
     RETURNING s.id, (s.xmax = 0) AS inserted`,
    [babyId, body.kind, body.deviceId, body.deviceLabel, body.albumTitle, body.wifiOnly],
  );
  const hit = rows[0];
  if (!hit) return null;
  const row = await sourceById(client, hit.id);
  return row ? { row, inserted: hit.inserted } : null;
}

/**
 * Apply a PATCH (owner only, RLS UPDATE). Counter fields are deltas (`col = col + $n`), so two
 * devices never lose each other's updates. `null` when RLS hides the row (not the owner, demoted,
 * or deleted: the client reads 404 as "sync turned off").
 */
export async function patchSource(
  client: Tx,
  id: string,
  body: PatchImportSourceRequest,
): Promise<SourceRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    sets.push(sql(`$${params.length}`));
  };
  if (body.albumTitle !== undefined) set((p) => `album_title = ${p}`, body.albumTitle);
  if (body.wifiOnly !== undefined) set((p) => `wifi_only = ${p}`, body.wifiOnly);
  if (body.paused !== undefined) set((p) => `paused = ${p}`, body.paused);
  if (body.lastSyncAt !== undefined)
    set((p) => `last_sync_at = ${p}::timestamptz`, body.lastSyncAt);
  if (body.lastTrigger !== undefined) set((p) => `last_trigger = ${p}`, body.lastTrigger);
  if (body.importedDelta)
    set((p) => `imported_count = imported_count + ${p}::int`, body.importedDelta);
  if (body.duplicateDelta) {
    set((p) => `duplicate_count = duplicate_count + ${p}::int`, body.duplicateDelta);
  }
  if (body.failedDelta) set((p) => `failed_count = failed_count + ${p}::int`, body.failedDelta);
  if (body.skippedDelta) set((p) => `skipped_count = skipped_count + ${p}::int`, body.skippedDelta);
  if (body.lastError !== undefined) set((p) => `last_error = ${p}`, body.lastError);
  // Zero deltas only: still a valid "I'm alive" PATCH; touch updated_at so it is a real UPDATE
  // (RLS decides visibility the same way).
  if (sets.length === 0) sets.push("updated_at = now()");
  const { rows } = await client.query<{ id: string }>(
    `UPDATE public.import_sources SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
    params,
  );
  const hit = rows[0];
  return hit ? sourceById(client, hit.id) : null;
}

/** Delete a sync row (owner or baby admin, RLS). The deleted row's baby, or `null`. */
export async function deleteSource(client: Tx, id: string): Promise<{ babyId: string } | null> {
  const { rows } = await client.query<{ baby_id: string }>(
    "DELETE FROM public.import_sources WHERE id = $1 RETURNING baby_id",
    [id],
  );
  const r = rows[0];
  return r ? { babyId: r.baby_id } : null;
}

// ---------------------------------------------------------------------------------------------
// google_accounts (the four columns granted to the owner)
// ---------------------------------------------------------------------------------------------

export interface ConnectionRow {
  connected_at: Date;
  needs_reconnect: boolean;
}

export async function loadConnection(client: Tx, uid: string): Promise<ConnectionRow | null> {
  const { rows } = await client.query<ConnectionRow>(
    "SELECT connected_at, needs_reconnect FROM public.google_accounts WHERE user_id = $1",
    [uid],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// import_batches (Google Picker)
// ---------------------------------------------------------------------------------------------

/**
 * Columns of one batch as the caller sees it (`$2` = the caller's uid). A `picking` batch past
 * its picker expiry reads `expired` before the poll / sweep writes it.
 */
const BATCH_COLUMNS = `
  b.id, b.baby_id, b.kind,
  CASE WHEN b.status = 'picking' AND b.picker_expires_at IS NOT NULL AND b.picker_expires_at < now()
       THEN 'expired' ELSE b.status END AS status,
  b.status AS stored_status,
  b.error, b.requested_by, mp.display_name AS requested_by_name,
  COALESCE(b.requested_by = $2, false) AS is_mine,
  b.items_total, b.items_imported, b.items_duplicate, b.items_failed, b.items_skipped,
  b.poll_interval_sec, b.picker_expires_at, b.last_polled_at, b.cancel_requested_at,
  b.created_at, b.started_at, b.finished_at,
  COALESCE(b.last_polled_at IS NULL
           OR b.last_polled_at <= now() - make_interval(secs => b.poll_interval_sec), true) AS poll_due`;

const BATCH_FROM = `
  FROM public.import_batches b
  LEFT JOIN public.member_profiles mp ON mp.user_id = b.requested_by`;

export interface BatchRow {
  id: string;
  baby_id: string;
  kind: "google_picker";
  /** Effective status (see `BATCH_COLUMNS`). */
  status: ImportBatchStatus;
  stored_status: ImportBatchStatus;
  error: ImportBatchError | null;
  requested_by: string | null;
  requested_by_name: string | null;
  is_mine: boolean;
  items_total: number | null;
  items_imported: number;
  items_duplicate: number;
  items_failed: number;
  items_skipped: number;
  poll_interval_sec: number;
  picker_expires_at: Date | null;
  last_polled_at: Date | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  /** `last_polled_at` is at least `poll_interval_sec` old (or unset). */
  poll_due: boolean;
}

export function toImportBatch(r: BatchRow): ImportBatch {
  return importBatchSchema.parse({
    id: r.id,
    babyId: r.baby_id,
    kind: r.kind,
    status: r.status,
    error: r.error,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    isMine: r.is_mine,
    itemsTotal: r.items_total,
    itemsImported: r.items_imported,
    itemsDuplicate: r.items_duplicate,
    itemsFailed: r.items_failed,
    itemsSkipped: r.items_skipped,
    pollIntervalSec: r.poll_interval_sec,
    pickerExpiresAt: r.picker_expires_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  });
}

export async function loadBatch(
  client: Tx,
  uid: string,
  batchId: string,
): Promise<BatchRow | null> {
  const { rows } = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} ${BATCH_FROM} WHERE b.id = $1`,
    [batchId, uid],
  );
  return rows[0] ?? null;
}

export async function listBatches(
  client: Tx,
  uid: string,
  babyId: string,
  limit: number,
): Promise<BatchRow[]> {
  const { rows } = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} ${BATCH_FROM}
      WHERE b.baby_id = $1
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $3`,
    [babyId, uid, limit],
  );
  return rows;
}

/** An active batch of the baby the caller can see (admins: any; others: their own). */
export async function hasVisibleActiveBatch(client: Tx, babyId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM public.import_batches b
      WHERE b.baby_id = $1
        AND (b.status IN ('queued', 'running')
             OR (b.status = 'picking'
                 AND COALESCE(b.picker_expires_at, b.created_at + interval '30 minutes') >= now()))
      LIMIT 1`,
    [babyId],
  );
  return rows.length > 0;
}

export interface NewBatchInput {
  babyId: string;
  sessionId: string;
  pollIntervalSec: number;
  pickerExpiresAt: Date;
}

/**
 * Insert a `picking` batch for the caller (RLS: member, `requested_by = auth_uid()`), with the
 * Google session id (insert-only column for `authenticated`), then set the poll interval and
 * picker expiry (update-only columns). `tz_hint` = the caller's profile time zone. Trigger
 * errors (in progress, rate limit, trashed) propagate to the global mapper.
 */
export async function insertBatch(client: Tx, input: NewBatchInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.import_batches (baby_id, requested_by, kind, tz_hint, provider_session_id)
     VALUES ($1, public.auth_uid(), 'google_picker',
             (SELECT p.timezone FROM public.profiles p WHERE p.user_id = public.auth_uid()), $2)
     RETURNING id`,
    [input.babyId, input.sessionId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("import batch insert returned no row");
  await client.query(
    `UPDATE public.import_batches
        SET poll_interval_sec = $2, picker_expires_at = $3
      WHERE id = $1`,
    [id, input.pollIntervalSec, input.pickerExpiresAt],
  );
  return id;
}

/**
 * Claim this poll slot: `last_polled_at = now()` only when the batch is still `picking` and the
 * last poll is at least `poll_interval_sec` old, so concurrent client polls ask Google at most
 * once per interval (D19). `true` when this request may poll.
 */
export async function claimPoll(client: Tx, batchId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE public.import_batches
        SET last_polled_at = now()
      WHERE id = $1 AND status = 'picking'
        AND (last_polled_at IS NULL
             OR last_polled_at <= now() - make_interval(secs => poll_interval_sec))`,
    [batchId],
  );
  return (rowCount ?? 0) > 0;
}

/** `picking` → `queued` | `cancelled` | `expired` (requester, RLS + transition trigger). */
export async function finishPicking(
  client: Tx,
  batchId: string,
  next: "queued" | "cancelled" | "expired",
): Promise<boolean> {
  const { rowCount } = await client.query(
    next === "queued"
      ? `UPDATE public.import_batches SET status = 'queued'
          WHERE id = $1 AND status = 'picking'`
      : `UPDATE public.import_batches SET status = $2, finished_at = now()
          WHERE id = $1 AND status = 'picking'`,
    next === "queued" ? [batchId] : [batchId, next],
  );
  return (rowCount ?? 0) > 0;
}

/** `queued` / `running`: ask the worker to stop after the current item. `true` when newly set. */
export async function requestCancel(client: Tx, batchId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE public.import_batches SET cancel_requested_at = now()
      WHERE id = $1 AND status IN ('queued', 'running') AND cancel_requested_at IS NULL`,
    [batchId],
  );
  return (rowCount ?? 0) > 0;
}

/** The caller's own `picking` batches (disconnect cancels them). */
export async function myPickingBatches(
  client: Tx,
  uid: string,
): Promise<{ id: string; baby_id: string }[]> {
  const { rows } = await client.query<{ id: string; baby_id: string }>(
    `SELECT id, baby_id FROM public.import_batches
      WHERE requested_by = $1 AND status = 'picking'`,
    [uid],
  );
  return rows;
}
