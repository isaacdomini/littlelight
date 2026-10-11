// SQL of the import worker (docs/plans/step-10.md 2.2, 2.7). Every statement runs as `pipeline`
// inside `runAsPipeline`; every statement names its columns. The worker never selects
// `google_accounts` (it has no grant): the refresh token comes only from
// `import_google_refresh_token()` (needs `app.data_key`), and photos are created only by
// `import_book_photo()` (the worker has no INSERT on `photos`).

/** `ok | not_active | not_member | baby_trashed | not_connected | reconnect`. */
export const REQUESTER_STATE_SQL = `SELECT public.import_batch_requester_state($1::uuid) AS state`;

/** The batch as the worker needs it (never logged: `provider_session_id`). */
export const LOAD_BATCH_SQL = `
SELECT id, baby_id, status, provider_session_id, tz_hint, cancel_requested_at
FROM import_batches WHERE id = $1`;

/** Claim: `queued | running` ⇒ `running` (a retried job re-claims its own `running` batch). */
export const CLAIM_BATCH_SQL = `
UPDATE import_batches SET status = 'running', started_at = COALESCE(started_at, now())
WHERE id = $1 AND baby_id = $2 AND status IN ('queued', 'running')
RETURNING id`;

/** Terminal state (`done | failed | cancelled`) of a queued/running batch. */
export const FINISH_BATCH_SQL = `
UPDATE import_batches SET status = $2, error = $3, finished_at = now()
WHERE id = $1 AND status IN ('queued', 'running')
RETURNING baby_id, items_imported, items_duplicate, items_failed, items_skipped`;

/** Plaintext refresh token (needs `app.data_key`); never logged, never stored by the worker. */
export const REFRESH_TOKEN_SQL = `SELECT public.import_google_refresh_token($1::uuid) AS token`;

/** `invalid_grant` ⇒ the requester must reconnect. */
export const MARK_RECONNECT_SQL = `SELECT public.import_mark_reconnect($1::uuid)`;

/** Has the requester asked to cancel? */
export const CANCEL_REQUESTED_SQL = `
SELECT cancel_requested_at IS NOT NULL AS cancel, status FROM import_batches WHERE id = $1`;

/**
 * Picked items of one listing (arrays of equal length): new rows only, a retried job keeps the
 * rows (and outcomes) of its earlier attempt.
 */
export const INSERT_ITEMS_SQL = `
INSERT INTO import_items (batch_id, baby_id, provider_item_id, mime_hint, width, height, taken_at_hint, status, error)
SELECT $1, $2, t.pid, t.mime, t.w, t.h, t.ts, t.status, t.err
FROM unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::timestamptz[], $8::text[], $9::text[])
  AS t(pid, mime, w, h, ts, status, err)
ON CONFLICT (batch_id, provider_item_id) DO NOTHING`;

/** Every item of the batch (`provider_item_id` stays in memory only). */
export const LIST_ITEMS_SQL = `
SELECT id, provider_item_id, status, storage_key FROM import_items WHERE batch_id = $1`;

export const SET_TOTAL_SQL = `UPDATE import_batches SET items_total = $2 WHERE id = $1`;

/**
 * Counters from the item rows (idempotent across retries); `$2` = picked items beyond
 * `IMPORT_BATCH_MAX_ITEMS` (skipped without a row). Bumps `updated_at`, which the sweep reads as
 * the batch's liveness.
 */
export const RECOUNT_SQL = `
UPDATE import_batches b
SET items_imported = c.booked, items_duplicate = c.dup, items_failed = c.failed,
    items_skipped = c.skipped + $2
FROM (
  SELECT count(*) FILTER (WHERE status = 'booked')::int AS booked,
         count(*) FILTER (WHERE status = 'duplicate')::int AS dup,
         count(*) FILTER (WHERE status = 'failed')::int AS failed,
         count(*) FILTER (WHERE status = 'skipped')::int AS skipped
  FROM import_items WHERE batch_id = $1
) c
WHERE b.id = $1
RETURNING b.items_imported, b.items_duplicate, b.items_failed, b.items_skipped`;

/** Duplicate pre-check (saves the PUT); mirrors `photos_baby_id_sha256_key`. */
export const DUPLICATE_PRECHECK_SQL = `
SELECT 1 FROM photos WHERE baby_id = $1 AND sha256 = $2 AND deleted_at IS NULL LIMIT 1`;

/** Bytes, hash and sniffed mime, before the PUT (the sweep cleans `downloaded` orphans). */
export const MARK_DOWNLOADED_SQL = `
UPDATE import_items SET status = 'downloaded', bytes = $2, sha256 = $3, mime_hint = $4, error = NULL
WHERE id = $1 AND status IN ('pending', 'downloaded')`;

/** `booked | duplicate | free_tier_limit | pending_limit | not_member | baby_trashed` (D10; step 11). */
export const BOOK_PHOTO_SQL = `SELECT public.import_book_photo($1::uuid) AS outcome`;

/** Terminal outcome of one open item. */
export const MARK_ITEM_SQL = `
UPDATE import_items SET status = $2, error = $3
WHERE id = $1 AND status IN ('pending', 'downloaded')`;

/** After a stop (free-tier or pending cap, requester gone, trashed album): every untouched item. */
export const MARK_PENDING_SQL = `
UPDATE import_items SET status = 'failed', error = $2
WHERE batch_id = $1 AND status = 'pending'`;

/** Audit row (actor NULL: `audit_log_pipeline_insert`); metadata passes `auditMetadataSchema`. */
export const AUDIT_SQL = `
INSERT INTO audit_log (baby_id, event, metadata) VALUES ($1, $2, $3::jsonb)`;

// --- import.sweep ------------------------------------------------------------------------------

/** Abandoned picker sessions (past `picker_expires_at`, or 30 minutes without one). */
export const EXPIRE_PICKING_SQL = `
UPDATE import_batches SET status = 'expired', finished_at = now()
WHERE status = 'picking'
  AND COALESCE(picker_expires_at, created_at + make_interval(mins => $1)) < now()
RETURNING id`;

/** Queued batches (the sweep checks each requester, then re-sends the stuck ones). */
export const QUEUED_BATCHES_SQL = `
SELECT id, baby_id, (updated_at < now() - make_interval(mins => $1)) AS stuck,
       floor(extract(epoch FROM now() - updated_at) / 60)::int AS age_min
FROM import_batches WHERE status = 'queued'
ORDER BY updated_at
LIMIT $2`;

/** Running batches without progress for `$1` minutes ⇒ `failed / internal`. */
export const FAIL_STALE_RUNNING_SQL = `
UPDATE import_batches SET status = 'failed', error = 'internal', finished_at = now()
WHERE status = 'running' AND updated_at < now() - make_interval(mins => $1)
RETURNING id, baby_id`;

/** `downloaded` items older than `$1` minutes with no photo row: their object is an orphan. */
export const ORPHAN_DOWNLOADED_SQL = `
SELECT i.id, i.storage_key FROM import_items i
WHERE i.status = 'downloaded' AND i.updated_at < now() - make_interval(mins => $1)
  AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.id = i.id)
ORDER BY i.updated_at
LIMIT $2`;

export const FAIL_ORPHAN_SQL = `
UPDATE import_items SET status = 'failed', error = 'storage_error'
WHERE id = $1 AND status = 'downloaded'`;

/**
 * Retention (policy `import_items_pipeline_delete`): items 30 days after their last change, when
 * terminal or their batch finished; never a `downloaded` item. Batches are kept.
 */
export const RETENTION_SQL = `
DELETE FROM import_items WHERE id IN (
  SELECT i.id FROM import_items i
  WHERE i.status <> 'downloaded' AND i.updated_at < now() - interval '30 days'
    AND (i.status IN ('booked', 'duplicate', 'failed', 'skipped')
         OR NOT EXISTS (SELECT 1 FROM import_batches b
                        WHERE b.id = i.batch_id AND b.status IN ('picking', 'queued', 'running')))
  LIMIT $1)`;
