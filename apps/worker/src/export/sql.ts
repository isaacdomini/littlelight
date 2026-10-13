// SQL of the data export (docs/plans/review-fixes.md 2.1 B, 2.3; PRD FR-10.1). Every statement
// runs as `pipeline` inside `runAsPipeline`. Column lists are explicit: `pipeline` reads only the
// columns granted to it (profiles: user_id, display_name, relationship_label). GPS is decrypted
// ONLY by `PHOTO_ROWS_WITH_GPS_SQL`, in a transaction that carries the data key and has just
// checked `export_requester_is_admin()` (handler.ts); every other statement runs without the key.

/**
 * Claim a queued export (or, on a pg-boss retry, the row a dead attempt left `running`). Only
 * live exports (not purged, not expired early by an admin) are claimed. Returns the row the
 * worker needs; `storage_key` stays inside the worker (never logged).
 */
export const CLAIM_EXPORT_SQL = `
UPDATE data_exports
   SET status = 'running', started_at = now(), finished_at = NULL, error = NULL, photos_done = 0
 WHERE id = $1 AND baby_id = $2
   AND (status = 'queued' OR (status = 'running' AND $3::boolean))
   AND purged_at IS NULL AND expires_at > now()
RETURNING id, baby_id, include_location, storage_key, expires_at`;

/** An export expired early (admin) before it started: never built, purged by the sweep. */
export const CANCEL_QUEUED_EXPORT_SQL = `
UPDATE data_exports SET status = 'expired', finished_at = now()
 WHERE id = $1 AND status = 'queued' AND expires_at <= now()`;

/** Run-time gate (security definer, pipeline only): requester still an admin with a live profile. */
export const REQUESTER_IS_ADMIN_SQL = `SELECT public.export_requester_is_admin($1) AS ok`;

/** The requester's address, or NULL (only for ready/failed exports of a still-admin requester). */
export const REQUESTER_EMAIL_SQL = `SELECT public.export_requester_email($1) AS email`;

/** `album.json` baby block (pipeline's column grants on `babies`). Never the encrypted home. */
export const BABY_SQL = `
SELECT id, name, nickname, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, birth_date_is_due_date,
       birth_weight_g, birth_length_mm, home_label
  FROM babies WHERE id = $1`;

/** `album.json` members: names, relationship and role only (no emails, no ids). */
export const MEMBERS_SQL = `
SELECT pr.display_name, pr.relationship_label, m.role
  FROM baby_members m
  LEFT JOIN profiles pr ON pr.user_id = m.user_id
 WHERE m.baby_id = $1
 ORDER BY m.role, m.joined_at, m.user_id`;

/**
 * The export's photo set (D4), keyset-paginated on `(sort_at, id)`: live, not quarantined, not
 * failed/duplicate, approved or pending. `sort_key` is the full-precision text of `sort_at` (a JS
 * Date would drop microseconds and break the keyset). `file_date` is the local capture date when
 * the EXIF offset is known, else the UTC date; `created_at` when there is no capture time.
 */
export const MANIFEST_PAGE_SQL = `
SELECT p.id, p.storage_key_original, p.mime, COALESCE(p.bytes, 0)::text AS bytes,
       COALESCE(p.taken_at, p.created_at) AS entry_date,
       to_char(
         CASE WHEN p.taken_at IS NOT NULL
              THEN (p.taken_at + make_interval(mins => COALESCE(e.tz_offset_minutes, 0))) AT TIME ZONE 'UTC'
              ELSE p.created_at AT TIME ZONE 'UTC' END,
         'YYYY-MM-DD') AS file_date,
       p.sort_at::text AS sort_key
  FROM photos p
  LEFT JOIN photo_exif e ON e.photo_id = p.id
 WHERE p.baby_id = $1
   AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
   AND p.status NOT IN ('failed', 'duplicate')
   AND p.approval IN ('approved', 'pending')
   AND (p.sort_at, p.id) > ($2::timestamptz, $3::uuid)
 ORDER BY p.sort_at, p.id
 LIMIT $4`;

/** Shared column list of the metadata rows (no GPS). `$1` = photo ids in manifest order. */
const PHOTO_ROW_COLUMNS = `
       p.id, p.taken_at, p.taken_at_estimated, e.tz_offset_minutes, p.age_days, p.status,
       p.approval, p.is_sensitive, pr.display_name AS uploaded_by_name, p.width, p.height,
       p.bytes::text AS bytes, p.mime, encode(p.sha256, 'hex') AS sha256,
       p.media_kind, p.duration_ms, p.video_codec,
       d.milestone_id, m.name AS milestone_name, m.category AS milestone_category,
       COALESCE(d.people, '{}') AS people, d.note, d.location_label,
       e.taken_at AS exif_taken_at, e.place_label, e.camera_make, e.camera_model, e.orientation,
       a.model AS ai_model, a.prompt_version AS ai_prompt_version,
       a.schema_version AS ai_schema_version, a.description AS ai_description,
       COALESCE(a.sensitive_flags, '{}') AS ai_sensitive_flags, a.updated_at AS ai_analyzed_at,
       (SELECT jsonb_object_agg(o.field_path, o.value)
          FROM photo_ai_overrides o WHERE o.photo_id = p.id) AS ai_overrides`;

const PHOTO_ROW_FROM = `
  FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ord)
  JOIN photos p ON p.id = u.id
  LEFT JOIN photo_exif e ON e.photo_id = p.id
  LEFT JOIN photo_details d ON d.photo_id = p.id
  LEFT JOIN milestones m ON m.id = d.milestone_id
  LEFT JOIN profiles pr ON pr.user_id = p.uploaded_by
  LEFT JOIN photo_ai a ON a.photo_id = p.id
 ORDER BY u.ord`;

/** Metadata rows of one chunk of the manifest, without any location. */
export const PHOTO_ROWS_SQL = `SELECT ${PHOTO_ROW_COLUMNS}${PHOTO_ROW_FROM}`;

/**
 * Metadata rows WITH decrypted GPS. Only in a transaction bound to the data key, right after
 * `REQUESTER_IS_ADMIN_SQL` returned true in that same transaction.
 */
export const PHOTO_ROWS_WITH_GPS_SQL = `SELECT ${PHOTO_ROW_COLUMNS},
       public.decrypt_coord(e.gps_lat_enc) AS gps_lat,
       public.decrypt_coord(e.gps_lng_enc) AS gps_lng${PHOTO_ROW_FROM}`;

/** `milestones.csv`: the baby's own milestones plus every preset (filtered by use in JS). */
export const MILESTONES_SQL = `
SELECT id, name, category, (baby_id IS NULL) AS is_preset
  FROM milestones
 WHERE baby_id = $1 OR baby_id IS NULL
 ORDER BY (baby_id IS NULL) DESC, sort_order, name, id`;

/** `measurements.csv`, keyset-paginated on `(measured_at, id)`. */
export const MEASUREMENTS_PAGE_SQL = `
SELECT id, kind, value_metric::text AS value_metric, value_entered::text AS value_entered,
       unit_entered, measured_at, measured_at::text AS cursor_at, note, photo_id
  FROM measurements
 WHERE baby_id = $1 AND (measured_at, id) > ($2::timestamptz, $3::uuid)
 ORDER BY measured_at, id
 LIMIT $4`;

/** Number of photos known up front (the manifest length). */
export const SET_PHOTO_COUNT_SQL = `
UPDATE data_exports SET photo_count = $2 WHERE id = $1 AND status = 'running'`;

/** Progress; tells the worker whether the export is still wanted (an admin may expire it early). */
export const PROGRESS_SQL = `
UPDATE data_exports SET photos_done = $2
 WHERE id = $1 AND status = 'running'
RETURNING (expires_at > now() AND purged_at IS NULL) AS live`;

export const MARK_READY_SQL = `
UPDATE data_exports
   SET status = 'ready', finished_at = now(), bytes = $2, photo_count = $3, photos_done = $3
 WHERE id = $1 AND status = 'running' AND expires_at > now() AND purged_at IS NULL
RETURNING expires_at`;

export const MARK_FAILED_SQL = `
UPDATE data_exports SET status = 'failed', error = $2, finished_at = now()
 WHERE id = $1 AND status = 'running'`;

/** A storage error with a retry left: back to `queued` so the pg-boss retry can claim it. */
export const REQUEUE_SQL = `
UPDATE data_exports SET status = 'queued', started_at = NULL, photos_done = 0
 WHERE id = $1 AND status = 'running'`;

/** Expired early by an admin while running: the partial ZIP is deleted, the sweep sets purged_at. */
export const MARK_CANCELLED_SQL = `
UPDATE data_exports SET status = 'expired', finished_at = now()
 WHERE id = $1 AND status = 'running'`;

/** Audit rows (actor NULL: `audit_log_pipeline_insert`). */
export const AUDIT_EXPORT_SQL = `
INSERT INTO audit_log (baby_id, event, metadata) VALUES ($1, $2, $3::jsonb)`;
