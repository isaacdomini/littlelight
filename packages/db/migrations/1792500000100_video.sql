-- Up Migration

-- Video uploads (docs/plans/step-12.md 2.2 A-E; decisions Q1-Q4, D1, D2, D8). PRD FR-2.1-2.5,
-- FR-2.7 (approval queue), FR-4.3/4.4 (GPS only encrypted, stripped from derivatives), FR-5.8
-- ("Free-tier photos are never sent to a model"), FR-6.1 (originals never modified), FR-9.5
-- (sensitive gate), FR-10.1-10.3. CLAUDE.md: RLS on every table; AI paid only; never log GPS.
--
-- A video is a row of `photos` (D1): `media_kind` tells them apart, so every rule that already
-- lives on `photos` (RLS, the family pool, the pending cap, approval, trash/purge, the share gate,
-- export, dedupe) applies to videos with no new code. Rules added here, in the database:
-- * Shape (`photos_media_shape`): a photo row carries no video columns and `rendition_status =
--   'none'`; a video row has `rendition_status <> 'none'`. Fixed message.
-- * Q3: at most `free_tier_video_limit()` (100; GUC `app.free_tier_video_limit`, never below 1)
--   counting videos across a free family's live albums (`photos_free_tier_video_cap`, advisory
--   lock class 1016 per family; same predicate as the 1,000-item pool, which videos also count
--   toward). Fixed message `free tier video limit reached (per family)`. All three caps (pool,
--   video, pending) now also fire on UPDATE OF status (a `failed -> ingested` retry re-admits a
--   row into its count).
-- * AI: a video is eligible only once its rendition is ready (keyframes exist only then); the
--   paid gate is unchanged (free albums never appear).
-- * Viewers (share links): may read `media_kind`, `duration_ms` and, for video rows only, the
--   `web` rendition key next to thumb/display (poster). Never the original, never keyframes.
-- * GPS tripwire: `jsonb_has_gps_keys` also matches QuickTime location keys (`location`,
--   `ISO6709`) so `photo_exif.raw_json` can never carry a clip's location tag.
-- * Import: `import_book_photo` books video items (free per-clip limits checked before the
--   insert: 60 s / 250 MB; the worker re-checks after download).
-- Per-plan byte and duration limits are not CHECK constraints (a plan can change); the api
-- enforces them at register and the worker after ffprobe. The CHECKs here are the hard ceilings
-- (2 GiB = the Plus maximum).

-------------------------------------------------------------------------------------------------
-- A. photos: media columns, mime, index, shape trigger, grants
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS media_kind       text    NOT NULL DEFAULT 'photo'
                                                    CHECK (media_kind IN ('photo', 'video')),
  ADD COLUMN IF NOT EXISTS duration_ms      integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  ADD COLUMN IF NOT EXISTS video_codec      text    CHECK (video_codec IN ('h264', 'hevc')),
  ADD COLUMN IF NOT EXISTS has_audio        boolean,
  ADD COLUMN IF NOT EXISTS rendition_status text    NOT NULL DEFAULT 'none'
                                                    CHECK (rendition_status IN ('none', 'pending', 'ready', 'failed'));
COMMENT ON COLUMN public.photos.media_kind IS
  'photo | video (D1: videos are rows of photos). Set by the api from the registered kind; the worker''s sniff is the truth and may flip it.';
COMMENT ON COLUMN public.photos.duration_ms IS
  'Video only: duration from ffprobe. NULL for photos (photos_media_shape).';
COMMENT ON COLUMN public.photos.video_codec IS
  'Video only: codec of the original (h264 | hevc). The web rendition is always h264.';
COMMENT ON COLUMN public.photos.has_audio IS
  'Video only: the original has an audio stream (kept in the rendition, never transcribed, Q7).';
COMMENT ON COLUMN public.photos.rendition_status IS
  'Video only: none (photos) | pending | ready (derivatives.web exists) | failed. A transcode failure never sets photos.status = failed.';

ALTER TABLE public.photos DROP CONSTRAINT IF EXISTS photos_mime_check;
ALTER TABLE public.photos ADD CONSTRAINT photos_mime_check
  CHECK (mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'video/mp4', 'video/quicktime'));

CREATE INDEX IF NOT EXISTS photos_baby_video_idx ON public.photos (baby_id)
  WHERE media_kind = 'video' AND deleted_at IS NULL;

-- Fixed message; names no value. Fires for every role.
CREATE OR REPLACE FUNCTION public.photos_media_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.media_kind = 'photo' THEN
    IF NEW.duration_ms IS NOT NULL OR NEW.video_codec IS NOT NULL OR NEW.has_audio IS NOT NULL
       OR NEW.rendition_status <> 'none' THEN
      RAISE EXCEPTION 'media columns inconsistent with media_kind' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.rendition_status = 'none' THEN
    RAISE EXCEPTION 'media columns inconsistent with media_kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_media_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_media_shape ON public.photos;
CREATE TRIGGER photos_media_shape BEFORE INSERT OR UPDATE ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_media_shape();

-- authenticated inserts the registered kind and the matching rendition_status (2.4); only the
-- worker writes the probed columns; viewers read kind + duration (badge). Nobody else changes.
GRANT INSERT (media_kind, rendition_status) ON public.photos TO authenticated;
GRANT UPDATE (media_kind, duration_ms, video_codec, has_audio, rendition_status) ON public.photos TO pipeline;
GRANT SELECT (media_kind, duration_ms) ON public.photos TO viewer;

-------------------------------------------------------------------------------------------------
-- A (Q3). Free video volume: at most free_tier_video_limit() counting videos per free family.
--
-- Counting videos (keep the copies identical: free_tier_pool_videos, photos_free_tier_video_cap):
--   the pool predicate of migration 21 AND p.media_kind = 'video'
-------------------------------------------------------------------------------------------------
-- 100 unless the operator set `ALTER DATABASE tinyglow SET app.free_tier_video_limit = '<n>'`
-- (FREE_TIER_VIDEO_LIMIT in @tinyglow/shared mirrors the default). Never below 1.
CREATE OR REPLACE FUNCTION public.free_tier_video_limit() RETURNS integer
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(1, COALESCE(NULLIF(btrim(current_setting('app.free_tier_video_limit', true)), '')::integer, 100))
$$;
COMMENT ON FUNCTION public.free_tier_video_limit() IS
  'Most approved videos a free family may hold across its free, live albums (inside the 1,000-item pool): 100, or the app.free_tier_video_limit setting (minimum 1).';

CREATE OR REPLACE FUNCTION public.free_tier_pool_videos(p_baby_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM public.babies t
  JOIN public.babies b ON b.family_id = t.family_id
  JOIN public.photos p ON p.baby_id = b.id
  WHERE t.id = p_baby_id
    AND b.deleted_at IS NULL
    AND b.plan = 'free'
    AND p.media_kind = 'video'
    AND p.approval = 'approved'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND p.status NOT IN ('failed', 'duplicate')
    AND (public.auth_claims() IS NULL OR public.is_baby_member(p_baby_id))
$$;
COMMENT ON FUNCTION public.free_tier_pool_videos(uuid) IS
  'Approved videos counting toward free_tier_video_limit() in this baby''s family (every free, live album). 0 for a non-member; full count without claims.';

REVOKE EXECUTE ON FUNCTION public.free_tier_video_limit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.free_tier_pool_videos(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.free_tier_video_limit() TO authenticated, pipeline, service_role;
GRANT EXECUTE ON FUNCTION public.free_tier_pool_videos(uuid) TO authenticated, pipeline, service_role;

-- The hard stop, same pattern as photos_free_tier_cap: fires for every role whenever a video
-- starts counting (inserted approved, approved, restored while approved, or an approved row the
-- worker's sniff flips from photo to video). Lock class 1016 per family (1011 is the pool, taken
-- first by trigger-name order; 1015 is the API's family-start guard). Counting runs after the lock
-- in a fresh statement snapshot: two concurrent inserts into one family at 99 admit exactly one.
CREATE OR REPLACE FUNCTION public.photos_free_tier_video_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan text;
  v_family uuid;
  v_used integer;
BEGIN
  IF NOT (NEW.media_kind = 'video' AND NEW.approval = 'approved' AND NEW.deleted_at IS NULL
          AND NEW.quarantined_at IS NULL AND NEW.status NOT IN ('failed', 'duplicate')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.media_kind = 'video' AND OLD.approval = 'approved' AND OLD.deleted_at IS NULL
     AND OLD.quarantined_at IS NULL AND OLD.status NOT IN ('failed', 'duplicate') THEN
    RETURN NEW;
  END IF;
  SELECT b.plan, b.family_id INTO v_plan, v_family FROM public.babies b WHERE b.id = NEW.baby_id;
  IF v_plan = 'free' THEN
    PERFORM pg_advisory_xact_lock(1016, hashtext(v_family::text));
    SELECT count(*) INTO v_used
    FROM public.photos p
    JOIN public.babies b ON b.id = p.baby_id
    WHERE b.family_id = v_family
      AND b.deleted_at IS NULL
      AND b.plan = 'free'
      AND p.media_kind = 'video'
      AND p.approval = 'approved'
      AND p.deleted_at IS NULL
      AND p.quarantined_at IS NULL
      AND p.status NOT IN ('failed', 'duplicate');
    IF v_used >= public.free_tier_video_limit() THEN
      RAISE EXCEPTION 'free tier video limit reached (per family)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photos_free_tier_video_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS photos_free_tier_video_cap ON public.photos;
CREATE TRIGGER photos_free_tier_video_cap BEFORE INSERT OR UPDATE OF approval, deleted_at, media_kind, status ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_free_tier_video_cap();

-- Both caps also fire on UPDATE OF status (review fix): the worker's FINISH_*_SQL moves a row
-- `failed -> ingested`, which re-admits an approved row into the count, so it must pass the cap
-- like an approval. The function bodies already skip rows that were counting before the UPDATE
-- (`uploaded -> ingested` of a fresh row, `ingested -> ingested` on a retried ingest): only a
-- row that was NOT counting (failed/duplicate, pending, trashed, quarantined) is checked. The
-- step-11 pool trigger is re-created here with the wider list; its function is unchanged.
DROP TRIGGER IF EXISTS photos_free_tier_cap ON public.photos;
CREATE TRIGGER photos_free_tier_cap BEFORE INSERT OR UPDATE OF approval, deleted_at, status ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_free_tier_cap();
-- Same for the per-guest pending cap: a pending upload's `failed -> ingested` retry re-enters the
-- pending count and must pass the cap like a new pending upload (function unchanged).
DROP TRIGGER IF EXISTS photos_pending_cap ON public.photos;
CREATE TRIGGER photos_pending_cap BEFORE INSERT OR UPDATE OF approval, deleted_at, status ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_pending_cap();

-------------------------------------------------------------------------------------------------
-- A. ai_eligible_photos: the step-6 body plus one line, a video needs rendition_status = 'ready'
-- (poster + keyframes exist only after the transcode). Grants kept by CREATE OR REPLACE.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_eligible_photos(
  p_limit integer,
  p_prompt_version text,
  p_schema_version text,
  p_baby_id uuid DEFAULT NULL,
  p_reprocess boolean DEFAULT false,
  p_max_attempts integer DEFAULT 2
) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT p.id
  FROM public.photos p
  WHERE p.approval = 'approved'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND (p.status = 'ingested' OR (p_reprocess AND p.status = 'ready'))
    AND (p.media_kind = 'photo' OR p.rendition_status = 'ready')
    AND p.baby_id IN (
      SELECT b.id FROM public.babies b
      WHERE (p_baby_id IS NULL OR b.id = p_baby_id) AND public.baby_ai_enabled(b.id)
    )
    AND EXISTS (SELECT 1 FROM public.photo_derivatives d WHERE d.photo_id = p.id AND d.kind = 'analysis')
    AND CASE WHEN p_reprocess
          THEN EXISTS (SELECT 1 FROM public.photo_ai a
                       WHERE a.photo_id = p.id
                         AND (a.prompt_version, a.schema_version) IS DISTINCT FROM (p_prompt_version, p_schema_version))
          ELSE NOT EXISTS (SELECT 1 FROM public.photo_ai a WHERE a.photo_id = p.id)
        END
    AND NOT EXISTS (SELECT 1 FROM public.ai_batch_items i
                    WHERE i.photo_id = p.id AND i.state IN ('pending', 'submitted'))
    AND (SELECT count(*) FROM public.ai_batch_items i
         WHERE i.photo_id = p.id AND i.state = 'failed'
           AND i.prompt_version = p_prompt_version AND i.schema_version = p_schema_version
           AND i.created_at > COALESCE(p.ai_retry_requested_at, '-infinity'::timestamptz)) < p_max_attempts
  ORDER BY p.created_at, p.id
  LIMIT p_limit
$$;
COMMENT ON FUNCTION public.ai_eligible_photos(integer, text, text, uuid, boolean, integer) IS
  'Photo ids eligible for an AI batch, oldest first (docs/plans/step-6.md 2.6). p_limit NULL = no limit; p_reprocess = version backfill (photo_ai exists for other versions); p_max_attempts mirrors AI_MAX_ATTEMPTS (default 2). Never returns a photo of a free-tier baby; a video only once rendition_status = ready (step 12).';

-------------------------------------------------------------------------------------------------
-- B. photo_derivatives: the rendition and the AI keyframes; viewers get `web` for videos only
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photo_derivatives DROP CONSTRAINT IF EXISTS photo_derivatives_kind_check;
ALTER TABLE public.photo_derivatives ADD CONSTRAINT photo_derivatives_kind_check
  CHECK (kind IN ('thumb', 'display', 'analysis', 'web', 'keyframe1', 'keyframe2', 'keyframe3'));
COMMENT ON TABLE public.photo_derivatives IS
  'Resized copies with all EXIF/GPS/QuickTime tags stripped. analysis (+ keyframe1..3 for videos) are the only copies that may reach a model; web is the playable video rendition (viewers may read it for video rows only).';

-- Set form for once-per-statement RLS, like viewer_media_photo_ids: the visible media rows that
-- are videos. SECURITY DEFINER: the viewer role has no SELECT on photos beyond its own policy.
CREATE OR REPLACE FUNCTION public.viewer_web_photo_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT sp.photo_id
  FROM public.shared_photos sp
  JOIN public.photos p ON p.id = sp.photo_id
  WHERE sp.share_link_id = (SELECT public.viewer_link_id())
    AND p.media_kind = 'video'
    AND p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
    AND (NOT p.is_sensitive OR (sp.added_by = 'user' AND sp.sensitive_released_at IS NOT NULL))
$$;
COMMENT ON FUNCTION public.viewer_web_photo_ids() IS
  'Video ids whose web rendition key the viewer may read: viewer_media_photo_ids() restricted to media_kind = video (step 12, Q9). Never a photo, never an original.';
REVOKE EXECUTE ON FUNCTION public.viewer_web_photo_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.viewer_web_photo_ids() TO viewer, service_role;

DROP POLICY IF EXISTS photo_derivatives_viewer_select ON public.photo_derivatives;
CREATE POLICY photo_derivatives_viewer_select ON public.photo_derivatives FOR SELECT TO viewer
  USING (
    (kind IN ('thumb', 'display') AND photo_id IN (SELECT public.viewer_media_photo_ids()))
    OR (kind = 'web' AND photo_id IN (SELECT public.viewer_web_photo_ids()))
  );

-------------------------------------------------------------------------------------------------
-- C. upload_files: registered kind, duration hint, 2 GiB ceiling, new error outcomes
-------------------------------------------------------------------------------------------------
ALTER TABLE public.upload_files
  ADD COLUMN IF NOT EXISTS media_kind          text    NOT NULL DEFAULT 'photo'
                                                       CHECK (media_kind IN ('photo', 'video')),
  ADD COLUMN IF NOT EXISTS declared_duration_ms integer CHECK (declared_duration_ms IS NULL OR declared_duration_ms > 0);
COMMENT ON COLUMN public.upload_files.media_kind IS
  'Kind the client registered (photo | video). A hint like client_mime: the worker re-sniffs.';
COMMENT ON COLUMN public.upload_files.declared_duration_ms IS
  'Client-reported duration of a video, used for the early per-plan refusal only; the worker measures the real one.';

ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_declared_bytes_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_declared_bytes_check
  CHECK (declared_bytes > 0 AND declared_bytes <= 2147483648);
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_client_mime_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_client_mime_check
  CHECK (client_mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'video/mp4', 'video/quicktime'));
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_error_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'decode_failed', 'free_tier_limit',
                   'rejected', 'expired', 'storage_error', 'upload_incomplete', 'pending_limit',
                   'video_too_long', 'transcode_failed'));

GRANT INSERT (media_kind, declared_duration_ms) ON public.upload_files TO authenticated;

-------------------------------------------------------------------------------------------------
-- D. import_items: video items; import_book_photo books them (free per-clip limits first)
-------------------------------------------------------------------------------------------------
ALTER TABLE public.import_items
  ADD COLUMN IF NOT EXISTS media_kind       text    NOT NULL DEFAULT 'photo'
                                                    CHECK (media_kind IN ('photo', 'video')),
  ADD COLUMN IF NOT EXISTS duration_ms_hint integer CHECK (duration_ms_hint IS NULL OR duration_ms_hint > 0);
COMMENT ON COLUMN public.import_items.media_kind IS
  'photo | video from the picker item type; the worker''s sniff after download is the truth.';
COMMENT ON COLUMN public.import_items.duration_ms_hint IS
  'Video duration from the provider''s metadata when present; the worker measures the real one.';

ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_mime_hint_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_mime_hint_check
  CHECK (mime_hint IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'video/mp4', 'video/quicktime'));
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_bytes_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_bytes_check
  CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 2147483648));
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_error_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'download_failed',
                   'free_tier_limit', 'storage_error', 'not_member', 'baby_trashed', 'pending_limit',
                   'video_too_long'));

GRANT UPDATE (media_kind, duration_ms_hint) ON public.import_items TO pipeline;

-- import_book_photo: the migration-21 body plus the media columns and the free per-clip limits
-- (Q1: 60 s, 250 MB = 262144000 bytes), checked before anything is inserted; the Q3 message maps
-- to 'free_tier_limit' like the pool's. Grants are kept by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.import_book_photo(p_item_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item record;
  v_role text;
  v_plan text;
  v_constraint text;
  v_message text;
BEGIN
  SELECT i.id, i.baby_id, i.storage_key, i.mime_hint, i.bytes, i.sha256, i.taken_at_hint, i.status,
         i.media_kind, i.duration_ms_hint,
         b.requested_by, b.status AS batch_status
    INTO v_item
  FROM public.import_items i
  JOIN public.import_batches b ON b.id = i.batch_id AND b.baby_id = i.baby_id
  WHERE i.id = p_item_id
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.status <> 'downloaded' OR v_item.bytes IS NULL OR v_item.sha256 IS NULL OR v_item.mime_hint IS NULL THEN
    RAISE EXCEPTION 'import item is not ready to book' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.batch_status <> 'running' THEN
    RAISE EXCEPTION 'import batch is not running' USING ERRCODE = 'check_violation';
  END IF;

  -- Role at run time; FOR SHARE holds it (no concurrent removal or role change) until commit.
  IF v_item.requested_by IS NOT NULL THEN
    SELECT m.role INTO v_role
    FROM public.baby_members m
    JOIN public.profiles p ON p.user_id = m.user_id AND p.deleted_at IS NULL
    WHERE m.baby_id = v_item.baby_id AND m.user_id = v_item.requested_by
    FOR SHARE OF m;
  END IF;
  IF v_role IS NULL THEN
    RETURN 'not_member';
  END IF;
  SELECT bb.plan INTO v_plan FROM public.babies bb WHERE bb.id = v_item.baby_id AND bb.deleted_at IS NULL;
  IF v_plan IS NULL THEN
    RETURN 'baby_trashed';
  END IF;

  -- Free per-clip limits (Q1), before anything is inserted. Duration is compared in rounded whole
  -- seconds, the api/worker rule (Math.round(ms / 1000) <= maxSeconds), so 60,400 ms passes and
  -- 60,500 ms is refused everywhere alike. The worker re-checks after ffprobe (a missing duration
  -- hint passes here).
  IF v_item.media_kind = 'video' AND v_plan = 'free' THEN
    IF round(v_item.duration_ms_hint / 1000.0) > 60 THEN
      RETURN 'video_too_long';
    END IF;
    IF v_item.bytes > 262144000 THEN
      RETURN 'file_too_large';
    END IF;
  END IF;

  BEGIN
    -- Mirrors photos_authenticated_insert: admin => approved by themselves; else pending, no
    -- approver. photos_free_tier_cap and photos_free_tier_video_cap fire for every insert.
    INSERT INTO public.photos
      (id, baby_id, uploaded_by, storage_key_original, mime, bytes, sha256, approval, approved_by,
       approved_at, taken_at, taken_at_estimated, media_kind, rendition_status)
    VALUES
      (v_item.id, v_item.baby_id, v_item.requested_by, v_item.storage_key, v_item.mime_hint,
       v_item.bytes, v_item.sha256,
       CASE WHEN v_role = 'admin' THEN 'approved' ELSE 'pending' END,
       CASE WHEN v_role = 'admin' THEN v_item.requested_by END,
       CASE WHEN v_role = 'admin' THEN now() END,
       v_item.taken_at_hint, true,
       v_item.media_kind,
       CASE WHEN v_item.media_kind = 'video' THEN 'pending' ELSE 'none' END);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'photos_baby_id_sha256_key' THEN
        RETURN 'duplicate';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'unique_violation';
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message LIKE 'free tier photo limit%' OR v_message LIKE 'free tier video limit%' THEN
        RETURN 'free_tier_limit';
      ELSIF v_message LIKE 'pending photo limit%' THEN
        RETURN 'pending_limit';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'check_violation';
  END;

  UPDATE public.import_items SET status = 'booked', photo_id = id, error = NULL WHERE id = p_item_id;
  RETURN 'booked';
END
$$;
COMMENT ON FUNCTION public.import_book_photo(uuid) IS
  'D10: books a downloaded import item (photo or video) as a photos row under the requester''s run-time role (admin => approved by the requester; contributor => pending, approved_by NULL). booked | duplicate | free_tier_limit | pending_limit | video_too_long | file_too_large | not_member | baby_trashed. pipeline only.';

-------------------------------------------------------------------------------------------------
-- E. GPS tripwire: QuickTime location keys (`com.apple.quicktime.location.ISO6709`, `location`)
-- now count as coordinate keys, so photo_exif.raw_json can never carry a clip's location tag.
-- Same shape as step 2 (IMMUTABLE, STRICT); grants kept by CREATE OR REPLACE.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jsonb_has_gps_keys(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_path_exists(
    doc,
    '$.** ? (@.type() == "object").keyvalue()
       ? (@.key like_regex "gps|latitude|longitude|location|iso6709|(^|[^a-z])geo|^(lat|lng|lon)$" flag "i")'
  )
$$;
COMMENT ON FUNCTION public.jsonb_has_gps_keys(jsonb) IS
  'True when any key at any depth looks like a coordinate (contains gps/latitude/longitude/location/iso6709, starts a word with geo, or is exactly lat/lng/lon).';

-- Down Migration

-- E. jsonb_has_gps_keys: the step-2 body and comment verbatim.
CREATE OR REPLACE FUNCTION public.jsonb_has_gps_keys(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_path_exists(
    doc,
    '$.** ? (@.type() == "object").keyvalue()
       ? (@.key like_regex "gps|latitude|longitude|(^|[^a-z])geo|^(lat|lng|lon)$" flag "i")'
  )
$$;
COMMENT ON FUNCTION public.jsonb_has_gps_keys(jsonb) IS
  'True when any key at any depth looks like a coordinate (contains gps/latitude/longitude, starts a word with geo, or is exactly lat/lng/lon).';

-- D. import_book_photo: the migration-21 body and comment verbatim.
CREATE OR REPLACE FUNCTION public.import_book_photo(p_item_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item record;
  v_role text;
  v_constraint text;
  v_message text;
BEGIN
  SELECT i.id, i.baby_id, i.storage_key, i.mime_hint, i.bytes, i.sha256, i.taken_at_hint, i.status,
         b.requested_by, b.status AS batch_status
    INTO v_item
  FROM public.import_items i
  JOIN public.import_batches b ON b.id = i.batch_id AND b.baby_id = i.baby_id
  WHERE i.id = p_item_id
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.status <> 'downloaded' OR v_item.bytes IS NULL OR v_item.sha256 IS NULL OR v_item.mime_hint IS NULL THEN
    RAISE EXCEPTION 'import item is not ready to book' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.batch_status <> 'running' THEN
    RAISE EXCEPTION 'import batch is not running' USING ERRCODE = 'check_violation';
  END IF;

  -- Role at run time; FOR SHARE holds it (no concurrent removal or role change) until commit.
  IF v_item.requested_by IS NOT NULL THEN
    SELECT m.role INTO v_role
    FROM public.baby_members m
    JOIN public.profiles p ON p.user_id = m.user_id AND p.deleted_at IS NULL
    WHERE m.baby_id = v_item.baby_id AND m.user_id = v_item.requested_by
    FOR SHARE OF m;
  END IF;
  IF v_role IS NULL THEN
    RETURN 'not_member';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.babies bb WHERE bb.id = v_item.baby_id AND bb.deleted_at IS NULL) THEN
    RETURN 'baby_trashed';
  END IF;

  BEGIN
    -- Mirrors photos_authenticated_insert: admin => approved by themselves; else pending, no
    -- approver. photos_free_tier_cap fires for every insert.
    INSERT INTO public.photos
      (id, baby_id, uploaded_by, storage_key_original, mime, bytes, sha256, approval, approved_by,
       approved_at, taken_at, taken_at_estimated)
    VALUES
      (v_item.id, v_item.baby_id, v_item.requested_by, v_item.storage_key, v_item.mime_hint,
       v_item.bytes, v_item.sha256,
       CASE WHEN v_role = 'admin' THEN 'approved' ELSE 'pending' END,
       CASE WHEN v_role = 'admin' THEN v_item.requested_by END,
       CASE WHEN v_role = 'admin' THEN now() END,
       v_item.taken_at_hint, true);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'photos_baby_id_sha256_key' THEN
        RETURN 'duplicate';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'unique_violation';
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message LIKE 'free tier photo limit%' THEN
        RETURN 'free_tier_limit';
      ELSIF v_message LIKE 'pending photo limit%' THEN
        RETURN 'pending_limit';
      END IF;
      RAISE EXCEPTION 'import item could not be booked' USING ERRCODE = 'check_violation';
  END;

  UPDATE public.import_items SET status = 'booked', photo_id = id, error = NULL WHERE id = p_item_id;
  RETURN 'booked';
END
$$;
COMMENT ON FUNCTION public.import_book_photo(uuid) IS
  'D10: books a downloaded import item as a photo under the requester''s run-time role (admin => approved by the requester; contributor => pending, approved_by NULL). booked | duplicate | free_tier_limit | pending_limit | not_member | baby_trashed. pipeline only.';

-- D. import_items: video rows cannot satisfy the step-10 CHECKs; they go (their photos rows are
-- removed with the videos below). Then the step-10/11 constraints and columns.
DELETE FROM public.import_items
  WHERE media_kind = 'video' OR mime_hint IN ('video/mp4', 'video/quicktime')
     OR bytes > 104857600 OR error = 'video_too_long';
REVOKE UPDATE (media_kind, duration_ms_hint) ON public.import_items FROM pipeline;
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_error_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'download_failed',
                   'free_tier_limit', 'storage_error', 'not_member', 'baby_trashed', 'pending_limit'));
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_bytes_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_bytes_check
  CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 104857600));
ALTER TABLE public.import_items DROP CONSTRAINT IF EXISTS import_items_mime_hint_check;
ALTER TABLE public.import_items ADD CONSTRAINT import_items_mime_hint_check
  CHECK (mime_hint IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'));
ALTER TABLE public.import_items DROP COLUMN IF EXISTS duration_ms_hint;
ALTER TABLE public.import_items DROP COLUMN IF EXISTS media_kind;

-- C. upload_files: likewise.
DELETE FROM public.upload_files
  WHERE media_kind = 'video' OR client_mime IN ('video/mp4', 'video/quicktime')
     OR declared_bytes > 104857600 OR error IN ('video_too_long', 'transcode_failed');
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_error_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_error_check
  CHECK (error IN ('unsupported_media_type', 'file_too_large', 'decode_failed', 'free_tier_limit',
                   'rejected', 'expired', 'storage_error', 'upload_incomplete', 'pending_limit'));
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_client_mime_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_client_mime_check
  CHECK (client_mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'));
ALTER TABLE public.upload_files DROP CONSTRAINT IF EXISTS upload_files_declared_bytes_check;
ALTER TABLE public.upload_files ADD CONSTRAINT upload_files_declared_bytes_check
  CHECK (declared_bytes > 0 AND declared_bytes <= 104857600);
ALTER TABLE public.upload_files DROP COLUMN IF EXISTS declared_duration_ms;
ALTER TABLE public.upload_files DROP COLUMN IF EXISTS media_kind;

-- B. photo_derivatives: the sharing-v1 viewer policy verbatim; drop the set helper; the new
-- kinds go (videos are removed below; a stray keyframe/web row of a photo cannot stay either).
DROP POLICY IF EXISTS photo_derivatives_viewer_select ON public.photo_derivatives;
CREATE POLICY photo_derivatives_viewer_select ON public.photo_derivatives FOR SELECT TO viewer
  USING (kind IN ('thumb', 'display') AND photo_id IN (SELECT public.viewer_media_photo_ids()));
DROP FUNCTION IF EXISTS public.viewer_web_photo_ids();
DELETE FROM public.photo_derivatives WHERE kind IN ('web', 'keyframe1', 'keyframe2', 'keyframe3');
ALTER TABLE public.photo_derivatives DROP CONSTRAINT IF EXISTS photo_derivatives_kind_check;
ALTER TABLE public.photo_derivatives ADD CONSTRAINT photo_derivatives_kind_check
  CHECK (kind IN ('thumb', 'display', 'analysis'));
COMMENT ON TABLE public.photo_derivatives IS
  'Resized copies with all EXIF/GPS stripped. analysis is the only copy that may reach a model.';

-- A. ai_eligible_photos: the step-6 body and comment verbatim.
CREATE OR REPLACE FUNCTION public.ai_eligible_photos(
  p_limit integer,
  p_prompt_version text,
  p_schema_version text,
  p_baby_id uuid DEFAULT NULL,
  p_reprocess boolean DEFAULT false,
  p_max_attempts integer DEFAULT 2
) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
  SELECT p.id
  FROM public.photos p
  WHERE p.approval = 'approved'
    AND p.deleted_at IS NULL
    AND p.quarantined_at IS NULL
    AND (p.status = 'ingested' OR (p_reprocess AND p.status = 'ready'))
    AND p.baby_id IN (
      SELECT b.id FROM public.babies b
      WHERE (p_baby_id IS NULL OR b.id = p_baby_id) AND public.baby_ai_enabled(b.id)
    )
    AND EXISTS (SELECT 1 FROM public.photo_derivatives d WHERE d.photo_id = p.id AND d.kind = 'analysis')
    AND CASE WHEN p_reprocess
          THEN EXISTS (SELECT 1 FROM public.photo_ai a
                       WHERE a.photo_id = p.id
                         AND (a.prompt_version, a.schema_version) IS DISTINCT FROM (p_prompt_version, p_schema_version))
          ELSE NOT EXISTS (SELECT 1 FROM public.photo_ai a WHERE a.photo_id = p.id)
        END
    AND NOT EXISTS (SELECT 1 FROM public.ai_batch_items i
                    WHERE i.photo_id = p.id AND i.state IN ('pending', 'submitted'))
    AND (SELECT count(*) FROM public.ai_batch_items i
         WHERE i.photo_id = p.id AND i.state = 'failed'
           AND i.prompt_version = p_prompt_version AND i.schema_version = p_schema_version
           AND i.created_at > COALESCE(p.ai_retry_requested_at, '-infinity'::timestamptz)) < p_max_attempts
  ORDER BY p.created_at, p.id
  LIMIT p_limit
$$;
COMMENT ON FUNCTION public.ai_eligible_photos(integer, text, text, uuid, boolean, integer) IS
  'Photo ids eligible for an AI batch, oldest first (docs/plans/step-6.md 2.6). p_limit NULL = no limit; p_reprocess = version backfill (photo_ai exists for other versions); p_max_attempts mirrors AI_MAX_ATTEMPTS (default 2). Never returns a photo of a free-tier baby.';

-- A (Q3) and the shape trigger; the step-11 pool and pending-cap triggers get their migration-21
-- column lists back.
DROP TRIGGER IF EXISTS photos_pending_cap ON public.photos;
CREATE TRIGGER photos_pending_cap BEFORE INSERT OR UPDATE OF approval, deleted_at ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_pending_cap();
DROP TRIGGER IF EXISTS photos_free_tier_cap ON public.photos;
CREATE TRIGGER photos_free_tier_cap BEFORE INSERT OR UPDATE OF approval, deleted_at ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.photos_free_tier_cap();
DROP TRIGGER IF EXISTS photos_free_tier_video_cap ON public.photos;
DROP FUNCTION IF EXISTS public.photos_free_tier_video_cap();
DROP FUNCTION IF EXISTS public.free_tier_pool_videos(uuid);
DROP FUNCTION IF EXISTS public.free_tier_video_limit();
DROP TRIGGER IF EXISTS photos_media_shape ON public.photos;
DROP FUNCTION IF EXISTS public.photos_media_shape();

-- A. photos: video rows cannot satisfy the step-2 mime CHECK; they go (cascading derivatives,
-- exif, details, search and share rows; a NOTICE with the count only). Then the step-2
-- constraint and the columns (their column grants go with them).
DO $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.photos WHERE media_kind = 'video' OR mime IN ('video/mp4', 'video/quicktime');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE 'video down: removed % video row(s) from photos', v_n;
  END IF;
END
$$;
DROP INDEX IF EXISTS public.photos_baby_video_idx;
ALTER TABLE public.photos DROP CONSTRAINT IF EXISTS photos_mime_check;
ALTER TABLE public.photos ADD CONSTRAINT photos_mime_check
  CHECK (mime IN ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'));
ALTER TABLE public.photos DROP COLUMN IF EXISTS rendition_status;
ALTER TABLE public.photos DROP COLUMN IF EXISTS has_audio;
ALTER TABLE public.photos DROP COLUMN IF EXISTS video_codec;
ALTER TABLE public.photos DROP COLUMN IF EXISTS duration_ms;
ALTER TABLE public.photos DROP COLUMN IF EXISTS media_kind;
