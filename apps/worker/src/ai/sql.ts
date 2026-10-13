// SQL of the AI batch pipeline (docs/plans/step-6.md 2.3, 2.6). Every statement runs as
// `pipeline` inside `runAsPipeline(pool, {}, …)`: never with the data key, and no statement here
// selects a GPS column (`photo_exif.gps_*_enc`, `raw_json`) or the baby's name. Exported as
// consts so unit tests can answer them by exact text (testing/stubs.ts `scriptedPool`).

// ---------------------------------------------------------------------------------------------
// Claim (flush step 2)
// ---------------------------------------------------------------------------------------------

/**
 * The open (unsealed) `building` batch for this provider/model/version pair, locked. A batch is
 * "sealed" for submission by setting `submitted_at` while still `building`; sealed batches never
 * receive new items.
 */
export const LOCK_OPEN_BATCH_SQL = `
SELECT id, photo_count, created_at
FROM ai_batches
WHERE status = 'building' AND submitted_at IS NULL
  AND provider = $1 AND model = $2 AND prompt_version = $3 AND schema_version = $4
ORDER BY created_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED`;

/** True when an open building batch exists but another transaction holds it. */
export const OPEN_BATCH_EXISTS_SQL = `
SELECT EXISTS (
  SELECT 1 FROM ai_batches
  WHERE status = 'building' AND submitted_at IS NULL
    AND provider = $1 AND model = $2 AND prompt_version = $3 AND schema_version = $4
) AS busy`;

export const INSERT_BATCH_SQL = `
INSERT INTO ai_batches (provider, model, prompt_version, schema_version, status, photo_count)
VALUES ($1, $2, $3, $4, 'building', 0)
RETURNING id, photo_count, created_at`;

/**
 * `ai_eligible_photos(p_limit, p_prompt_version, p_schema_version, p_baby_id, p_reprocess,
 * p_max_attempts)`, minus `$7`: photos already released (dropped, unbuildable, budget-skipped)
 * earlier in the same `flush()` call, which must not be re-claimed in that call. Oldest first.
 */
export const ELIGIBLE_SQL = `
SELECT e.id
FROM ai_eligible_photos($1::int + cardinality($7::uuid[]), $2::text, $3::text, $4::uuid, $5::boolean, $6::int) AS e(id)
WHERE e.id <> ALL($7::uuid[])
LIMIT $1`;

/**
 * Baby, media kind (the budget weighs a video at `AI_VIDEO_COST_FACTOR` photos; step 12) and
 * attempt number of each eligible photo (failed attempts for these versions since the retry flag).
 */
export const CLAIM_INFO_SQL = `
SELECT p.id, p.baby_id, p.media_kind,
       (SELECT count(*) FROM ai_batch_items i
        WHERE i.photo_id = p.id AND i.state = 'failed'
          AND i.prompt_version = $2 AND i.schema_version = $3
          AND i.created_at > COALESCE(p.ai_retry_requested_at, '-infinity'::timestamptz))::int AS failed_attempts
FROM photos p
WHERE p.id = ANY($1::uuid[])
ORDER BY p.created_at, p.id`;

/**
 * Month-to-date spend of one baby (UTC), plus the estimate for its items still in flight
 * (their cost is unknown until results arrive), so a large claim cannot overshoot the budget.
 * `$3` is the per-photo estimate, `$4` the per-video estimate (step 12: a video item carries up
 * to four frames, `AI_VIDEO_COST_FACTOR`).
 */
export const BABY_MONTH_SPEND_SQL = `
SELECT ai_baby_month_cost_usd($1::uuid, $2::date)::float8
     + (SELECT COALESCE(sum(CASE WHEN p.media_kind = 'video' THEN $4::float8 ELSE $3::float8 END), 0)
          FROM ai_batch_items i
          JOIN photos p ON p.id = i.photo_id
         WHERE i.baby_id = $1::uuid AND i.cost_usd IS NULL
           AND i.state IN ('pending', 'submitted')
           AND i.created_at >= (date_trunc('month', $2::date::timestamp) AT TIME ZONE 'UTC'))::float8
       AS spent`;

/**
 * One `ai.budget_exceeded {month}` audit row per baby per UTC month, durable across processes
 * and replicas (`record_ai_budget_exceeded`: insert-if-absent under an advisory lock). `inserted`
 * is true only for the call that wrote the row. `$2` is `YYYY-MM`.
 */
export const AUDIT_BUDGET_EXCEEDED_SQL = `
SELECT public.record_ai_budget_exceeded($1::uuid, $2::text) AS inserted`;

/** One pending item per claimed photo (`ai_batch_items_guard` re-checks the paid gate). */
export const INSERT_ITEMS_SQL = `
INSERT INTO ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version)
SELECT $1::uuid, t.photo_id, t.baby_id, t.attempt, $5::text, $6::text
FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS t(photo_id, baby_id, attempt)`;

/** `photos_status_guard` re-checks approved/live/paid for `queued`. */
export const MARK_QUEUED_SQL = `
UPDATE photos SET status = 'queued'
WHERE id = ANY($1::uuid[]) AND status IN ('ingested', 'ready')`;

export const ADD_PHOTO_COUNT_SQL = `
UPDATE ai_batches SET photo_count = photo_count + $2 WHERE id = $1`;

export const SEAL_BATCH_SQL = `
UPDATE ai_batches SET submitted_at = now()
WHERE id = $1 AND status = 'building'`;

/** Sealed batches whose submitter died (lease expired), retried by the next flush. */
export const LOCK_STALE_SEALED_SQL = `
SELECT id FROM ai_batches
WHERE status = 'building' AND submitted_at IS NOT NULL
  AND submitted_at < now() - make_interval(mins => $2::int)
  AND provider = $1
ORDER BY submitted_at, id
LIMIT 10
FOR UPDATE SKIP LOCKED`;

// ---------------------------------------------------------------------------------------------
// Submit (flush step 3)
// ---------------------------------------------------------------------------------------------

/**
 * Pending items with what the request needs: the analysis derivative key (a video's poster),
 * the video's keyframe keys (`keyframe1..3`, in kind order; empty for photos; step 12), its
 * `media_kind` / `duration_ms`, and the per-photo context (age, capture time + offset, coarse
 * place labels, parent people/note/milestone name). Selects NO GPS column, no `raw_json`, no
 * baby name, never the original or the `web` rendition key.
 */
export const LOAD_PENDING_SQL = `
SELECT i.photo_id, i.baby_id, i.attempt,
       d.storage_key,
       p.media_kind, p.duration_ms,
       ARRAY(SELECT k.storage_key FROM photo_derivatives k
              WHERE k.photo_id = p.id AND k.kind IN ('keyframe1', 'keyframe2', 'keyframe3')
              ORDER BY k.kind) AS keyframe_keys,
       p.age_days, p.taken_at, p.taken_at_estimated,
       e.taken_at AS exif_taken_at, e.tz_offset_minutes, e.place_label,
       pd.people, pd.note, pd.location_label,
       m.name AS milestone_name
FROM ai_batch_items i
JOIN photos p ON p.id = i.photo_id
LEFT JOIN photo_derivatives d ON d.photo_id = p.id AND d.kind = 'analysis'
LEFT JOIN photo_exif e ON e.photo_id = p.id
LEFT JOIN photo_details pd ON pd.photo_id = p.id
LEFT JOIN milestones m ON m.id = pd.milestone_id
WHERE i.batch_id = $1 AND i.state = 'pending'
ORDER BY p.created_at, p.id`;

/** The re-check right before `describeBatch`: still approved, live and paid. */
export const RECHECK_SQL = `
SELECT p.id
FROM photos p
WHERE p.id = ANY($1::uuid[])
  AND p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
  AND public.baby_ai_enabled(p.baby_id)`;

/** Items removed before submission (re-check failed). */
export const DROP_ITEMS_SQL = `
UPDATE ai_batch_items SET state = 'dropped'
WHERE batch_id = $1 AND photo_id = ANY($2::uuid[]) AND state = 'pending'`;

/** Items that could not be built (analysis copy unreadable): a counted, failed attempt. */
export const FAIL_PENDING_ITEMS_SQL = `
UPDATE ai_batch_items SET state = 'failed', failure_kind = $3
WHERE batch_id = $1 AND photo_id = ANY($2::uuid[]) AND state = 'pending'`;

/** Over-the-byte-cap items go back to the queue (never submitted, no cost): removed. */
export const RELEASE_ITEMS_SQL = `
DELETE FROM ai_batch_items
WHERE batch_id = $1 AND photo_id = ANY($2::uuid[]) AND state = 'pending'`;

/**
 * A photo leaves the AI queue without a result: back to `ready` when it still has a
 * (previous-version) description, else `ingested`. Never `failed` (plan D4).
 */
export const RELEASE_PHOTOS_SQL = `
UPDATE photos p
SET status = CASE WHEN EXISTS (SELECT 1 FROM photo_ai a WHERE a.photo_id = p.id) THEN 'ready' ELSE 'ingested' END
WHERE p.id = ANY($1::uuid[]) AND p.status IN ('queued', 'analyzing')`;

export const MARK_SUBMITTED_SQL = `
UPDATE ai_batches
SET status = 'submitted',
    provider_batch_id = $2,
    provider_input_file_id = $3,
    submitted_at = $4::timestamptz,
    expires_at = COALESCE($5::timestamptz, $4::timestamptz + interval '24 hours'),
    submitted_bytes = $6,
    photo_count = $7,
    error = NULL,
    request_counts = NULL
WHERE id = $1`;

export const MARK_ITEMS_SUBMITTED_SQL = `
UPDATE ai_batch_items SET state = 'submitted'
WHERE batch_id = $1 AND photo_id = ANY($2::uuid[]) AND state = 'pending'`;

/** Skips photos whose baby went free since the re-check (the guard would raise otherwise). */
export const MARK_ANALYZING_SQL = `
UPDATE photos SET status = 'analyzing'
WHERE id = ANY($1::uuid[]) AND status = 'queued' AND public.baby_ai_enabled(baby_id)`;

/** Provider call failed: unseal (more photos may join), remember the attempt count. */
export const SUBMIT_FAILED_SQL = `
UPDATE ai_batches
SET submitted_at = NULL, error = $2,
    request_counts = jsonb_build_object('submit_attempts', $3::int),
    photo_count = $4
WHERE id = $1 AND status = 'building'`;

export const BATCH_SUBMIT_ATTEMPTS_SQL = `
SELECT COALESCE((request_counts ->> 'submit_attempts')::int, 0) AS attempts
FROM ai_batches WHERE id = $1`;

/** Terminal failure of a batch that never reached the provider (or became empty). */
export const CLOSE_UNSUBMITTED_BATCH_SQL = `
UPDATE ai_batches
SET status = $2, error = $3, completed_at = now(), photo_count = $4
WHERE id = $1 AND status = 'building'`;

export const PENDING_ITEM_IDS_SQL = `
SELECT photo_id FROM ai_batch_items WHERE batch_id = $1 AND state = 'pending'`;

// ---------------------------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------------------------

export const OPEN_BATCHES_SQL = `
SELECT id, provider, model, provider_batch_id, provider_input_file_id,
       provider_output_file_id, provider_error_file_id, submitted_at, photo_count,
       prompt_version, schema_version, status, expires_at
FROM ai_batches
WHERE status IN ('submitted', 'in_progress') AND provider = $1 AND provider_batch_id IS NOT NULL
ORDER BY submitted_at, id
LIMIT $2`;

/** Open batches of another provider (after a VISION_PROVIDER switch): warned about, not polled. */
export const OTHER_PROVIDER_OPEN_SQL = `
SELECT count(*)::int AS n FROM ai_batches
WHERE status IN ('submitted', 'in_progress') AND provider <> $1`;

export const UPDATE_PROGRESS_SQL = `
UPDATE ai_batches
SET status = $2, last_polled_at = now(), request_counts = $3::jsonb,
    provider_output_file_id = COALESCE($4, provider_output_file_id),
    provider_error_file_id = COALESCE($5, provider_error_file_id),
    expires_at = COALESCE($6::timestamptz, expires_at)
WHERE id = $1 AND status IN ('submitted', 'in_progress')`;

/** Idempotency: only an item still `submitted` takes a result. */
export const CLAIM_RESULT_SQL = `
UPDATE ai_batch_items
SET state = $3, failure_kind = $4,
    input_tokens = $5, cached_input_tokens = $6, output_tokens = $7,
    reasoning_tokens = $8, image_tokens = $9, cost_usd = $10
WHERE batch_id = $1 AND photo_id = $2 AND state = 'submitted'
RETURNING baby_id, public.baby_ai_enabled(baby_id) AS ai_enabled`;

/** Version backfills replace the row; the tripwire and the sensitive sync triggers fire. */
export const UPSERT_PHOTO_AI_SQL = `
INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description,
                      sensitive_flags, confidence, batch_id, input_tokens, output_tokens)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9, $10)
ON CONFLICT (photo_id) DO UPDATE SET
  model = EXCLUDED.model,
  prompt_version = EXCLUDED.prompt_version,
  schema_version = EXCLUDED.schema_version,
  description = EXCLUDED.description,
  sensitive_flags = EXCLUDED.sensitive_flags,
  confidence = EXCLUDED.confidence,
  batch_id = EXCLUDED.batch_id,
  input_tokens = EXCLUDED.input_tokens,
  output_tokens = EXCLUDED.output_tokens`;

export const MARK_READY_SQL = `
UPDATE photos SET status = 'ready'
WHERE id = $1 AND status IN ('queued', 'analyzing', 'ingested')`;

/** Items without a result once the batch is terminal. */
export const FAIL_MISSING_ITEMS_SQL = `
UPDATE ai_batch_items SET state = 'failed', failure_kind = $2
WHERE batch_id = $1 AND state = 'submitted'
RETURNING photo_id`;

export const BATCH_TOTALS_SQL = `
UPDATE ai_batches b
SET status = $2, completed_at = now(), last_polled_at = now(),
    request_counts = $3::jsonb,
    provider_output_file_id = COALESCE($4, b.provider_output_file_id),
    provider_error_file_id = COALESCE($5, b.provider_error_file_id),
    error = $6,
    input_tokens = s.input_tokens, cached_input_tokens = s.cached_input_tokens,
    output_tokens = s.output_tokens, reasoning_tokens = s.reasoning_tokens,
    image_tokens = s.image_tokens, cost_usd = s.cost_usd
FROM (
  SELECT COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
         COALESCE(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens,
         COALESCE(sum(output_tokens), 0)::bigint AS output_tokens,
         COALESCE(sum(reasoning_tokens), 0)::bigint AS reasoning_tokens,
         COALESCE(sum(image_tokens), 0)::bigint AS image_tokens,
         COALESCE(sum(cost_usd), 0) AS cost_usd
  FROM ai_batch_items WHERE batch_id = $1
) s
WHERE b.id = $1 AND b.status IN ('submitted', 'in_progress')
RETURNING s.cost_usd::float8 AS cost_usd, s.reasoning_tokens::int AS reasoning_tokens`;

/** Terminal batches whose provider artifacts are not deleted yet (retried every poll). */
export const UNDELETED_BATCHES_SQL = `
SELECT id, provider, model, provider_batch_id, provider_input_file_id,
       provider_output_file_id, provider_error_file_id, submitted_at, photo_count,
       prompt_version, schema_version, status, completed_at
FROM ai_batches
WHERE status IN ('completed', 'failed', 'expired', 'cancelled')
  AND files_deleted_at IS NULL AND provider_batch_id IS NOT NULL AND provider = $1
ORDER BY completed_at NULLS FIRST, id
LIMIT $2`;

export const MARK_FILES_DELETED_SQL = `
UPDATE ai_batches SET files_deleted_at = now() WHERE id = $1 AND files_deleted_at IS NULL`;

// ---------------------------------------------------------------------------------------------
// Queue age (PRD "Reliability and operations": alert when queue age > 2 h)
// ---------------------------------------------------------------------------------------------

export const OLDEST_ELIGIBLE_SQL = `
SELECT (EXTRACT(EPOCH FROM (now() - p.created_at)) / 60)::float8 AS minutes
FROM ai_eligible_photos(1, $1::text, $2::text, NULL::uuid, false, $3::int) AS e(id)
JOIN photos p ON p.id = e.id`;

export const OLDEST_OPEN_BATCH_SQL = `
SELECT (EXTRACT(EPOCH FROM (now() - min(COALESCE(submitted_at, created_at)))) / 60)::float8 AS minutes
FROM ai_batches
WHERE status IN ('building', 'submitted', 'in_progress')`;
