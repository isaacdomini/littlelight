-- Up Migration

-- Step 5 (docs/plans/step-5.md 2.3; PRD "FR-3 Parent-supplied details", "FR-8 Browsing",
-- "Data model", "Non-functional requirements -> Performance"): the timeline sort index, the SQL
-- twin of the age-group function, and the details/milestone/measurement rules the API relies on.
--
-- Rules enforced here, not in the API or the UI:
-- * RLS stays ENABLE + FORCE on every table touched; no policy body changes. No new grant to
--   `viewer` or `pipeline` on any table.
-- * Presets (`milestones.baby_id IS NULL`) remain immutable for every user role: the step-2
--   UPDATE/DELETE policies require `baby_id IS NOT NULL AND is_baby_admin(baby_id)`, and
--   `authenticated` has no UPDATE grant on `baby_id`, so a custom milestone can never be turned
--   into a preset either. Custom milestones stay admin-only for INSERT/UPDATE/DELETE.
-- * At most 200 custom milestones per baby (`milestones_cap`, check_violation "milestone limit
--   reached"; MAX_CUSTOM_MILESTONES_PER_BABY in @littlelight/shared). The baby row is locked so
--   two concurrent inserts cannot both pass the count.
-- * A custom milestone's name may not equal a preset's name, case-insensitively (plan D7:
--   "two First steps in the picker"), on INSERT and on rename. The step-2 unique index covers
--   only `(baby_id, lower(name))`; `milestones_name_guard` raises unique_violation with the same
--   constraint name so the API's existing 23505 -> 409 mapping applies unchanged.
-- * `measurements.photo_id`, when set, must be a live (not trashed, not quarantined) photo of
--   the measurement's own baby (`measurements_photo_same_baby`, check_violation "measurement
--   photo must belong to the same baby"). Writes to `measurements` remain admin-only (step-2
--   policies, unchanged).
-- * `photo_details` edits remain governed by `photo_editable` (admins, or the uploader of a
--   pending photo; never a trashed or quarantined photo). Unchanged.
-- * `age_group(age_days)` is IMMUTABLE, SECURITY INVOKER and must return exactly the keys of
--   @littlelight/shared `ageGroupKey` (step-5 plan 2.2); the two are compared by a test.
--
-- No CHECK constraint on parent-entered text ("shape triggers"). A CHECK failure reports
-- `Failing row contains (...)` in the error DETAIL, which Postgres writes to the server log, so a
-- rejected row would put the parent's note, people, location, names, chat titles or an
-- invitee's email into the log. Every non-enum CHECK on a table that holds parent-entered text
-- is therefore dropped here and re-stated as a BEFORE INSERT OR UPDATE trigger that raises
-- check_violation (23514, exactly what a CHECK raises) with a fixed message that names no
-- value. Enum CHECKs (`col IN (...)`) stay: their values are API-chosen literals, they feed the
-- generated row types, and the API validates them before the row is built. The step-2/4
-- constraints converted (restored verbatim by the down migration):
--   photo_details_note_check, measurements_note_check, measurements value_metric/value_entered
--   > 0 (as part of measurements_shape), milestones_name_check, babies_name_check,
--   babies_birth_weight_g_check, babies_birth_length_mm_check, upload_sessions_note_check,
--   upload_sessions_location_label_check, share_links_name_check, chat_threads_title_check,
--   invites_email_check, photo_ai_overrides_field_path_check.
-- New step-5 limits added the same way: photo_details.people <= 20, photo_details.location_label
-- <= 120, upload_sessions.people <= 20, measurements.value_metric <= 200000 (200 kg / 200 m:
-- a sanity bound; the real input bounds are MEASUREMENT_LIMITS in @littlelight/shared).
-- Trigger functions are plain plpgsql (they read only NEW) and are not executable by app roles.
-- Nothing in this migration logs or echoes notes, people, labels, names or bytes.

-------------------------------------------------------------------------------------------------
-- photos: timeline sort column + index (plan D2, stored-column alternative). `sort_at` is a
-- STORED generated column = COALESCE(taken_at, created_at). A plain column is needed because
-- under row-level security the planner may only push a keyset bound into the index when every
-- operator in it is leakproof; the COALESCE expression is not, so with an expression index the
-- bound stayed in the post-RLS Filter and page N scanned N x 200 rows (~250 ms at page 49 as
-- authenticated vs 0.3 ms as superuser). With `(sort_at, id) < ($2, $3)` (btree row compare on
-- plain columns, leakproof) the bound is an Index Cond for every role.
-- API contract: ORDER BY p.sort_at DESC, p.id DESC; keyset (p.sort_at, p.id) < ($2, $3) for
-- older pages and > for newer (ASC). Replaces the step-2 (baby_id, taken_at DESC) index.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photos ADD COLUMN IF NOT EXISTS sort_at timestamptz
  GENERATED ALWAYS AS (COALESCE(taken_at, created_at)) STORED NOT NULL;
COMMENT ON COLUMN public.photos.sort_at IS
  'COALESCE(taken_at, created_at), stored: the timeline sort key and keyset cursor (step 5).';
DROP INDEX IF EXISTS public.photos_baby_id_taken_at_idx;
DROP INDEX IF EXISTS public.photos_baby_id_sort_idx;
CREATE INDEX IF NOT EXISTS photos_baby_id_sort_idx
  ON public.photos (baby_id, sort_at DESC, id DESC)
  WHERE deleted_at IS NULL;
-- authenticated and pipeline hold table-level SELECT on photos (new columns included); viewer has
-- a column list that already carries taken_at/created_at, so it gets the derived column too.
GRANT SELECT (sort_at) ON public.photos TO viewer;
-- Group summary: SELECT age_group(age_days), count(*) ... GROUP BY 1 per baby.
CREATE INDEX IF NOT EXISTS photos_baby_id_age_days_idx
  ON public.photos (baby_id, age_days)
  WHERE deleted_at IS NULL;

-------------------------------------------------------------------------------------------------
-- photos SELECT policy: membership evaluated once per statement, not once per row.
-- is_baby_admin(baby_id) / is_baby_member(baby_id) are SECURITY DEFINER SQL functions that run a
-- baby_members lookup per candidate row: a 10k-row GROUP BY or a deep keyset page cost ~260 ms in
-- policy calls alone. admin_baby_ids() / member_baby_ids() return the caller's baby ids as an
-- array from the same baby_members read (same SECURITY DEFINER, same auth_uid() source), and the
-- policy wraps them (and auth_uid()) in uncorrelated scalar sub-selects, which the planner turns
-- into InitPlans evaluated once per statement. Semantics are identical to the step-4 policy:
-- admins see everything of their babies incl. trash and the approval queue; contributors see the
-- approved live album plus their own uploads in any state; a quarantined row exists for nobody.
-- Only the SELECT policy changes (UPDATE/INSERT act on single rows). Viewer/pipeline unchanged.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_baby_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT m.baby_id FROM public.baby_members m WHERE m.user_id = public.auth_uid()
$$;
CREATE OR REPLACE FUNCTION public.admin_baby_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT m.baby_id FROM public.baby_members m WHERE m.user_id = public.auth_uid() AND m.role = 'admin'
$$;
COMMENT ON FUNCTION public.member_baby_ids() IS
  'Baby ids the signed-in user is a member of (any role); empty without authenticated claims. Set form of is_baby_member for once-per-statement RLS.';
COMMENT ON FUNCTION public.admin_baby_ids() IS
  'Baby ids the signed-in user administers; empty without authenticated claims. Set form of is_baby_admin for once-per-statement RLS.';
REVOKE EXECUTE ON FUNCTION public.member_baby_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_baby_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.member_baby_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_baby_ids() TO authenticated, service_role;

DROP POLICY IF EXISTS photos_authenticated_select ON public.photos;
CREATE POLICY photos_authenticated_select ON public.photos FOR SELECT TO authenticated
  USING (
    quarantined_at IS NULL
    AND (
      baby_id IN (SELECT public.admin_baby_ids())
      OR (baby_id IN (SELECT public.member_baby_ids())
          AND ((approval = 'approved' AND deleted_at IS NULL) OR uploaded_by = (SELECT public.auth_uid())))
    )
  );

-------------------------------------------------------------------------------------------------
-- age_group: SQL twin of @littlelight/shared ageGroupKey (plan 2.2). Keep the two identical.
--   NULL            -> 'unknown'  (not ingested yet / no birth date)
--   < 0             -> 'pre'      (before birth)
--   0  <= d < 84    -> 'w' || floor(d / 7) + 1          (w1..w12)
--   84 <= d < 730   -> 'm' || floor(d / 30.4375) + 1    (m3..m24)
--   d >= 730        -> 'y' || floor(d / 365)            (y2..)
-- IMMUTABLE: pure arithmetic on its argument; SECURITY INVOKER: it reads nothing.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.age_group(age_days integer) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER
AS $$
  SELECT CASE
           WHEN age_days IS NULL THEN 'unknown'
           WHEN age_days < 0 THEN 'pre'
           WHEN age_days < 84 THEN 'w' || (age_days / 7 + 1)::text
           WHEN age_days < 730 THEN 'm' || (floor(age_days / 30.4375)::integer + 1)::text
           ELSE 'y' || (age_days / 365)::text
         END
$$;
COMMENT ON FUNCTION public.age_group(integer) IS
  'Timeline age-group key for photos.age_days: unknown, pre, w1..w12, m3..m24, y2.. Mirrors @littlelight/shared ageGroupKey exactly.';
REVOKE EXECUTE ON FUNCTION public.age_group(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.age_group(integer) TO authenticated, viewer, pipeline, service_role;

-------------------------------------------------------------------------------------------------
-- milestones: updated_at (the durable "stale" signal step 7 reconciles against, plan D5),
-- the per-baby cap and the name guard (length + no preset names). Policies unchanged.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.milestones ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS milestones_set_updated_at ON public.milestones;
CREATE TRIGGER milestones_set_updated_at BEFORE UPDATE ON public.milestones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Column list becomes (name, category, sort_order, updated_at); the step-2 grant stays, this adds
-- the new column. Still no UPDATE on baby_id/created_by: a custom milestone cannot become a preset.
GRANT UPDATE (updated_at) ON public.milestones TO authenticated;
COMMENT ON TABLE public.milestones IS
  'NULL baby_id = global preset (immutable for every user role). Custom milestones: admin-only, max 200 per baby, name 1..80 chars, unique per baby and never equal to a preset name (case-insensitive).';

-- Cap: at most 200 custom milestones per baby. SECURITY DEFINER so the count is exact whatever
-- the caller may see; the baby row is locked (NO KEY UPDATE) so concurrent inserts serialize.
CREATE OR REPLACE FUNCTION public.milestones_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  n_custom integer;
BEGIN
  IF NEW.baby_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.babies b WHERE b.id = NEW.baby_id FOR NO KEY UPDATE;
  SELECT count(*) INTO n_custom FROM public.milestones m WHERE m.baby_id = NEW.baby_id;
  IF n_custom >= 200 THEN
    RAISE EXCEPTION 'milestone limit reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.milestones_cap() FROM PUBLIC;
DROP TRIGGER IF EXISTS milestones_cap ON public.milestones;
CREATE TRIGGER milestones_cap BEFORE INSERT ON public.milestones
  FOR EACH ROW EXECUTE FUNCTION public.milestones_cap();

-- Name guard: 1..80 characters (replaces milestones_name_check, see header) and, for custom
-- milestones (D7), never a preset's name, on insert or rename. The preset clash is raised as
-- unique_violation on the step-2 unique index's name so callers treat it exactly like a
-- duplicate custom name (API: 409 "A milestone with that name already exists"). No message
-- names a value.
ALTER TABLE public.milestones DROP CONSTRAINT IF EXISTS milestones_name_check;
CREATE OR REPLACE FUNCTION public.milestones_name_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.name) < 1 OR length(NEW.name) > 80 THEN
    RAISE EXCEPTION 'milestones.name must be 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.baby_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.milestones p
    WHERE p.baby_id IS NULL AND lower(p.name) = lower(NEW.name)
  ) THEN
    RAISE EXCEPTION 'milestone name matches a preset'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'milestones_baby_id_lower_name_key';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.milestones_name_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS milestones_name_guard ON public.milestones;
CREATE TRIGGER milestones_name_guard BEFORE INSERT OR UPDATE OF name ON public.milestones
  FOR EACH ROW EXECUTE FUNCTION public.milestones_name_guard();

-------------------------------------------------------------------------------------------------
-- photo_details: shape limits (note <= 2000 replaces photo_details_note_check; people <= 20;
-- location_label <= 120), the milestone same-baby rule (milestone_id is NULL, a preset, or a
-- milestone of the photo's own baby: a custom milestone of another album can never be attached),
-- and the covering index the milestones list uses for counts and covers. SECURITY DEFINER so
-- the rule is evaluated against the real rows whatever the caller may see.
-------------------------------------------------------------------------------------------------
ALTER TABLE public.photo_details DROP CONSTRAINT IF EXISTS photo_details_note_check;
CREATE OR REPLACE FUNCTION public.photo_details_shape() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.note IS NOT NULL AND length(NEW.note) > 2000 THEN
    RAISE EXCEPTION 'photo_details.note is longer than 2000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.people) > 20 THEN
    RAISE EXCEPTION 'photo_details.people holds at most 20 entries' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.location_label IS NOT NULL AND length(NEW.location_label) > 120 THEN
    RAISE EXCEPTION 'photo_details.location_label is longer than 120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.milestones m
    JOIN public.photos p ON p.id = NEW.photo_id
    WHERE m.id = NEW.milestone_id AND (m.baby_id IS NULL OR m.baby_id = p.baby_id)
  ) THEN
    RAISE EXCEPTION 'photo_details.milestone_id must belong to the same baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_details_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_details_shape ON public.photo_details;
CREATE TRIGGER photo_details_shape BEFORE INSERT OR UPDATE OF note, people, location_label, milestone_id ON public.photo_details
  FOR EACH ROW EXECUTE FUNCTION public.photo_details_shape();

DROP INDEX IF EXISTS public.photo_details_milestone_id_idx;
CREATE INDEX IF NOT EXISTS photo_details_milestone_id_photo_id_idx
  ON public.photo_details (milestone_id, photo_id)
  WHERE milestone_id IS NOT NULL;

-------------------------------------------------------------------------------------------------
-- measurements: the linked photo must be a live photo of the same baby; shape limits (note,
-- positive values, sanity bound) replace measurements_note_check / value_metric_check /
-- value_entered_check; index for the photo detail's "linked measurements" and the reindex hook.
-------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.measurements_photo_same_baby() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.photo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.photos p
    WHERE p.id = NEW.photo_id
      AND p.baby_id = NEW.baby_id
      AND p.deleted_at IS NULL
      AND p.quarantined_at IS NULL
  ) THEN
    RAISE EXCEPTION 'measurement photo must belong to the same baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.measurements_photo_same_baby() FROM PUBLIC;
DROP TRIGGER IF EXISTS measurements_photo_same_baby ON public.measurements;
CREATE TRIGGER measurements_photo_same_baby BEFORE INSERT OR UPDATE OF photo_id, baby_id ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.measurements_photo_same_baby();

ALTER TABLE public.measurements DROP CONSTRAINT IF EXISTS measurements_note_check;
ALTER TABLE public.measurements DROP CONSTRAINT IF EXISTS measurements_value_metric_check;
ALTER TABLE public.measurements DROP CONSTRAINT IF EXISTS measurements_value_entered_check;
CREATE OR REPLACE FUNCTION public.measurements_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.note IS NOT NULL AND length(NEW.note) > 2000 THEN
    RAISE EXCEPTION 'measurements.note is longer than 2000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.value_metric <= 0 OR NEW.value_entered <= 0 THEN
    RAISE EXCEPTION 'measurements values must be positive' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.value_metric > 200000 THEN
    RAISE EXCEPTION 'measurements.value_metric exceeds the sanity bound' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.measurements_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS measurements_shape ON public.measurements;
CREATE TRIGGER measurements_shape BEFORE INSERT OR UPDATE OF note, value_metric, value_entered ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.measurements_shape();

CREATE INDEX IF NOT EXISTS measurements_photo_id_idx
  ON public.measurements (photo_id)
  WHERE photo_id IS NOT NULL;

-------------------------------------------------------------------------------------------------
-- Shape triggers for the other tables holding parent-entered text (see header).
-------------------------------------------------------------------------------------------------
-- babies: name 1..80 (babies_name_check), birth measurements positive (babies_birth_weight_g_check,
-- babies_birth_length_mm_check). The row also carries nickname and home_label.
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_name_check;
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_birth_weight_g_check;
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_birth_length_mm_check;
CREATE OR REPLACE FUNCTION public.babies_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.name) < 1 OR length(NEW.name) > 80 THEN
    RAISE EXCEPTION 'babies.name must be 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.birth_weight_g IS NOT NULL AND NEW.birth_weight_g <= 0 THEN
    RAISE EXCEPTION 'babies.birth_weight_g must be positive' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.birth_length_mm IS NOT NULL AND NEW.birth_length_mm <= 0 THEN
    RAISE EXCEPTION 'babies.birth_length_mm must be positive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.babies_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS babies_shape ON public.babies;
CREATE TRIGGER babies_shape BEFORE INSERT OR UPDATE OF name, birth_weight_g, birth_length_mm ON public.babies
  FOR EACH ROW EXECUTE FUNCTION public.babies_shape();

-- upload_sessions: batch note <= 2000 (upload_sessions_note_check), location_label <= 120
-- (upload_sessions_location_label_check), people <= 20 (new; matches the API's limit), and the
-- same milestone rule as photo_details (the batch milestone lands on every completed photo).
ALTER TABLE public.upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_note_check;
ALTER TABLE public.upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_location_label_check;
CREATE OR REPLACE FUNCTION public.upload_sessions_shape() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.note IS NOT NULL AND length(NEW.note) > 2000 THEN
    RAISE EXCEPTION 'upload_sessions.note is longer than 2000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.location_label IS NOT NULL AND length(NEW.location_label) > 120 THEN
    RAISE EXCEPTION 'upload_sessions.location_label is longer than 120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.people) > 20 THEN
    RAISE EXCEPTION 'upload_sessions.people holds at most 20 entries' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.milestones m
    WHERE m.id = NEW.milestone_id AND (m.baby_id IS NULL OR m.baby_id = NEW.baby_id)
  ) THEN
    RAISE EXCEPTION 'upload_sessions.milestone_id must belong to the same baby' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.upload_sessions_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS upload_sessions_shape ON public.upload_sessions;
CREATE TRIGGER upload_sessions_shape BEFORE INSERT OR UPDATE OF note, location_label, people, milestone_id ON public.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.upload_sessions_shape();

-- share_links: name 1..80 (share_links_name_check). The row also carries token/passcode hashes.
ALTER TABLE public.share_links DROP CONSTRAINT IF EXISTS share_links_name_check;
CREATE OR REPLACE FUNCTION public.share_links_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.name) < 1 OR length(NEW.name) > 80 THEN
    RAISE EXCEPTION 'share_links.name must be 1 to 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_links_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS share_links_shape ON public.share_links;
CREATE TRIGGER share_links_shape BEFORE INSERT OR UPDATE OF name ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_shape();

-- chat_threads: title <= 200 (chat_threads_title_check). Titles derive from parent prompts.
ALTER TABLE public.chat_threads DROP CONSTRAINT IF EXISTS chat_threads_title_check;
CREATE OR REPLACE FUNCTION public.chat_threads_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.title IS NOT NULL AND length(NEW.title) > 200 THEN
    RAISE EXCEPTION 'chat_threads.title is longer than 200 characters' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.chat_threads_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS chat_threads_shape ON public.chat_threads;
CREATE TRIGGER chat_threads_shape BEFORE INSERT OR UPDATE OF title ON public.chat_threads
  FOR EACH ROW EXECUTE FUNCTION public.chat_threads_shape();

-- invites: email lower-case and 3..320 (invites_email_check). The invitee's address is PII.
ALTER TABLE public.invites DROP CONSTRAINT IF EXISTS invites_email_check;
CREATE OR REPLACE FUNCTION public.invites_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.email <> lower(NEW.email) OR length(NEW.email) < 3 OR length(NEW.email) > 320 THEN
    RAISE EXCEPTION 'invites.email must be lower-case and 3 to 320 characters' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.invites_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS invites_shape ON public.invites;
CREATE TRIGGER invites_shape BEFORE INSERT OR UPDATE OF email ON public.invites
  FOR EACH ROW EXECUTE FUNCTION public.invites_shape();

-- photo_ai_overrides: field_path 1..200 (photo_ai_overrides_field_path_check). The row carries
-- the parent's correction text in `value`.
ALTER TABLE public.photo_ai_overrides DROP CONSTRAINT IF EXISTS photo_ai_overrides_field_path_check;
CREATE OR REPLACE FUNCTION public.photo_ai_overrides_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF length(NEW.field_path) < 1 OR length(NEW.field_path) > 200 THEN
    RAISE EXCEPTION 'photo_ai_overrides.field_path must be 1 to 200 characters' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.photo_ai_overrides_shape() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_ai_overrides_shape ON public.photo_ai_overrides;
CREATE TRIGGER photo_ai_overrides_shape BEFORE INSERT OR UPDATE OF field_path ON public.photo_ai_overrides
  FOR EACH ROW EXECUTE FUNCTION public.photo_ai_overrides_shape();

-- Down Migration

-- Shape triggers -> the original CHECK constraints, verbatim.
DROP TRIGGER IF EXISTS photo_ai_overrides_shape ON public.photo_ai_overrides;
DROP FUNCTION IF EXISTS public.photo_ai_overrides_shape();
ALTER TABLE public.photo_ai_overrides DROP CONSTRAINT IF EXISTS photo_ai_overrides_field_path_check;
ALTER TABLE public.photo_ai_overrides ADD CONSTRAINT photo_ai_overrides_field_path_check CHECK (length(field_path) BETWEEN 1 AND 200);

DROP TRIGGER IF EXISTS invites_shape ON public.invites;
DROP FUNCTION IF EXISTS public.invites_shape();
ALTER TABLE public.invites DROP CONSTRAINT IF EXISTS invites_email_check;
ALTER TABLE public.invites ADD CONSTRAINT invites_email_check CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320);

DROP TRIGGER IF EXISTS chat_threads_shape ON public.chat_threads;
DROP FUNCTION IF EXISTS public.chat_threads_shape();
ALTER TABLE public.chat_threads DROP CONSTRAINT IF EXISTS chat_threads_title_check;
ALTER TABLE public.chat_threads ADD CONSTRAINT chat_threads_title_check CHECK (length(title) <= 200);

DROP TRIGGER IF EXISTS share_links_shape ON public.share_links;
DROP FUNCTION IF EXISTS public.share_links_shape();
ALTER TABLE public.share_links DROP CONSTRAINT IF EXISTS share_links_name_check;
ALTER TABLE public.share_links ADD CONSTRAINT share_links_name_check CHECK (length(name) BETWEEN 1 AND 80);

DROP TRIGGER IF EXISTS upload_sessions_shape ON public.upload_sessions;
DROP FUNCTION IF EXISTS public.upload_sessions_shape();
ALTER TABLE public.upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_note_check;
ALTER TABLE public.upload_sessions ADD CONSTRAINT upload_sessions_note_check CHECK (length(note) <= 2000);
ALTER TABLE public.upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_location_label_check;
ALTER TABLE public.upload_sessions ADD CONSTRAINT upload_sessions_location_label_check CHECK (length(location_label) <= 120);

DROP TRIGGER IF EXISTS babies_shape ON public.babies;
DROP FUNCTION IF EXISTS public.babies_shape();
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_name_check;
ALTER TABLE public.babies ADD CONSTRAINT babies_name_check CHECK (length(name) BETWEEN 1 AND 80);
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_birth_weight_g_check;
ALTER TABLE public.babies ADD CONSTRAINT babies_birth_weight_g_check CHECK (birth_weight_g > 0);
ALTER TABLE public.babies DROP CONSTRAINT IF EXISTS babies_birth_length_mm_check;
ALTER TABLE public.babies ADD CONSTRAINT babies_birth_length_mm_check CHECK (birth_length_mm > 0);

DROP INDEX IF EXISTS public.measurements_photo_id_idx;
DROP TRIGGER IF EXISTS measurements_shape ON public.measurements;
DROP FUNCTION IF EXISTS public.measurements_shape();
ALTER TABLE public.measurements DROP CONSTRAINT IF EXISTS measurements_note_check;
ALTER TABLE public.measurements ADD CONSTRAINT measurements_note_check CHECK (length(note) <= 2000);
ALTER TABLE public.measurements DROP CONSTRAINT IF EXISTS measurements_value_metric_check;
ALTER TABLE public.measurements ADD CONSTRAINT measurements_value_metric_check CHECK (value_metric > 0);
ALTER TABLE public.measurements DROP CONSTRAINT IF EXISTS measurements_value_entered_check;
ALTER TABLE public.measurements ADD CONSTRAINT measurements_value_entered_check CHECK (value_entered > 0);
DROP TRIGGER IF EXISTS measurements_photo_same_baby ON public.measurements;
DROP FUNCTION IF EXISTS public.measurements_photo_same_baby();

DROP INDEX IF EXISTS public.photo_details_milestone_id_photo_id_idx;
CREATE INDEX IF NOT EXISTS photo_details_milestone_id_idx ON public.photo_details (milestone_id);
DROP TRIGGER IF EXISTS photo_details_shape ON public.photo_details;
DROP FUNCTION IF EXISTS public.photo_details_shape();
ALTER TABLE public.photo_details DROP CONSTRAINT IF EXISTS photo_details_note_check;
ALTER TABLE public.photo_details ADD CONSTRAINT photo_details_note_check CHECK (length(note) <= 2000);

DROP TRIGGER IF EXISTS milestones_name_guard ON public.milestones;
DROP FUNCTION IF EXISTS public.milestones_name_guard();
ALTER TABLE public.milestones DROP CONSTRAINT IF EXISTS milestones_name_check;
ALTER TABLE public.milestones ADD CONSTRAINT milestones_name_check CHECK (length(name) BETWEEN 1 AND 80);
DROP TRIGGER IF EXISTS milestones_cap ON public.milestones;
DROP FUNCTION IF EXISTS public.milestones_cap();
COMMENT ON TABLE public.milestones IS NULL;
DROP TRIGGER IF EXISTS milestones_set_updated_at ON public.milestones;
ALTER TABLE public.milestones DROP COLUMN IF EXISTS updated_at;

DROP FUNCTION IF EXISTS public.age_group(integer);

-- photos SELECT policy: restore the step-4 body exactly, then drop the array helpers.
DROP POLICY IF EXISTS photos_authenticated_select ON public.photos;
CREATE POLICY photos_authenticated_select ON public.photos FOR SELECT TO authenticated
  USING (
    quarantined_at IS NULL
    AND (
      public.is_baby_admin(baby_id)
      OR (public.is_baby_member(baby_id)
          AND ((approval = 'approved' AND deleted_at IS NULL) OR uploaded_by = public.auth_uid()))
    )
  );
DROP FUNCTION IF EXISTS public.admin_baby_ids();
DROP FUNCTION IF EXISTS public.member_baby_ids();

DROP INDEX IF EXISTS public.photos_baby_id_age_days_idx;
DROP INDEX IF EXISTS public.photos_baby_id_sort_idx;
ALTER TABLE public.photos DROP COLUMN IF EXISTS sort_at;
CREATE INDEX IF NOT EXISTS photos_baby_id_taken_at_idx ON public.photos (baby_id, taken_at DESC) WHERE deleted_at IS NULL;
