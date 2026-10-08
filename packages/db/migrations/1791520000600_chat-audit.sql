-- Up Migration

-- Chat (admins of a paid-tier baby only; viewers and contributors never) and the append-only
-- audit log (docs/plans/step-2.md 2.4-2.6; PRD "Auth security requirements").

-------------------------------------------------------------------------------------------------
-- chat_threads / chat_messages. baby_id is denormalised onto messages so RLS stays a single check.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_threads (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baby_id     uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  title       text        CHECK (length(title) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_threads_baby_id_user_id_updated_at_idx
  ON public.chat_threads (baby_id, user_id, updated_at DESC);
ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_threads FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS chat_threads_set_updated_at ON public.chat_threads;
CREATE TRIGGER chat_threads_set_updated_at BEFORE UPDATE ON public.chat_threads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid        NOT NULL REFERENCES public.chat_threads (id) ON DELETE CASCADE,
  baby_id          uuid        NOT NULL REFERENCES public.babies (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
  role             text        NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content          text        NOT NULL,
  cited_photo_ids  uuid[]      NOT NULL DEFAULT '{}',
  tokens_in        integer,
  tokens_out       integer,
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_id_created_at_idx ON public.chat_messages (thread_id, created_at);
COMMENT ON TABLE public.chat_messages IS
  'Chat transcript. content may contain parent notes quoted by the model: never logged.';
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages FORCE ROW LEVEL SECURITY;

-- A message's baby/user must match its thread (the denormalised columns cannot drift).
CREATE OR REPLACE FUNCTION public.chat_messages_thread_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_threads t
    WHERE t.id = NEW.thread_id AND t.baby_id = NEW.baby_id AND t.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'chat message must belong to its thread''s baby and user' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.chat_messages_thread_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS chat_messages_thread_guard ON public.chat_messages;
CREATE TRIGGER chat_messages_thread_guard BEFORE INSERT OR UPDATE OF thread_id, baby_id, user_id ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_thread_guard();

-------------------------------------------------------------------------------------------------
-- audit_log: append-only. No role, including service_role, may UPDATE or DELETE.
-------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  baby_id        uuid        REFERENCES public.babies (id) ON DELETE SET NULL,
  actor_user_id  uuid        REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  share_link_id  uuid        REFERENCES public.share_links (id) ON DELETE SET NULL,
  event          text        NOT NULL CHECK (length(event) BETWEEN 1 AND 100),
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_baby_id_created_at_idx ON public.audit_log (baby_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_user_id_created_at_idx ON public.audit_log (actor_user_id, created_at DESC);
COMMENT ON TABLE public.audit_log IS
  'Append-only admin/auth activity log. metadata never holds tokens, GPS, notes or prompts.';
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;

-------------------------------------------------------------------------------------------------
-- Grants and policies.
-------------------------------------------------------------------------------------------------
GRANT ALL ON public.chat_threads, public.chat_messages TO service_role;
-- The default privilege granted ALL on audit_log to service_role at creation; take back mutation.
GRANT SELECT, INSERT ON public.audit_log TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.audit_log FROM service_role;
GRANT USAGE ON SEQUENCE public.audit_log_id_seq TO authenticated, pipeline, service_role;

-- chat_threads ----------------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.chat_threads TO authenticated;
GRANT INSERT (id, baby_id, user_id, title) ON public.chat_threads TO authenticated;
GRANT UPDATE (title, updated_at) ON public.chat_threads TO authenticated;

DROP POLICY IF EXISTS chat_threads_authenticated_select ON public.chat_threads;
CREATE POLICY chat_threads_authenticated_select ON public.chat_threads FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) AND user_id = public.auth_uid());
DROP POLICY IF EXISTS chat_threads_authenticated_insert ON public.chat_threads;
CREATE POLICY chat_threads_authenticated_insert ON public.chat_threads FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(baby_id) AND user_id = public.auth_uid() AND public.baby_ai_enabled(baby_id));
DROP POLICY IF EXISTS chat_threads_authenticated_update ON public.chat_threads;
CREATE POLICY chat_threads_authenticated_update ON public.chat_threads FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id) AND user_id = public.auth_uid())
  WITH CHECK (public.is_baby_admin(baby_id) AND user_id = public.auth_uid());
DROP POLICY IF EXISTS chat_threads_authenticated_delete ON public.chat_threads;
CREATE POLICY chat_threads_authenticated_delete ON public.chat_threads FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id) AND user_id = public.auth_uid());

-- chat_messages ---------------------------------------------------------------------------------
GRANT SELECT, DELETE ON public.chat_messages TO authenticated;
GRANT INSERT (id, thread_id, baby_id, user_id, role, content, cited_photo_ids, tokens_in, tokens_out, model)
  ON public.chat_messages TO authenticated;
GRANT UPDATE (content, cited_photo_ids, tokens_in, tokens_out, model) ON public.chat_messages TO authenticated;

DROP POLICY IF EXISTS chat_messages_authenticated_select ON public.chat_messages;
CREATE POLICY chat_messages_authenticated_select ON public.chat_messages FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) AND user_id = public.auth_uid());
DROP POLICY IF EXISTS chat_messages_authenticated_insert ON public.chat_messages;
CREATE POLICY chat_messages_authenticated_insert ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (public.is_baby_admin(baby_id) AND user_id = public.auth_uid() AND public.baby_ai_enabled(baby_id));
DROP POLICY IF EXISTS chat_messages_authenticated_update ON public.chat_messages;
CREATE POLICY chat_messages_authenticated_update ON public.chat_messages FOR UPDATE TO authenticated
  USING (public.is_baby_admin(baby_id) AND user_id = public.auth_uid())
  WITH CHECK (public.is_baby_admin(baby_id) AND user_id = public.auth_uid());
DROP POLICY IF EXISTS chat_messages_authenticated_delete ON public.chat_messages;
CREATE POLICY chat_messages_authenticated_delete ON public.chat_messages FOR DELETE TO authenticated
  USING (public.is_baby_admin(baby_id) AND user_id = public.auth_uid());

-- audit_log -------------------------------------------------------------------------------------
GRANT SELECT ON public.audit_log TO authenticated;
GRANT INSERT (baby_id, actor_user_id, share_link_id, event, metadata) ON public.audit_log TO authenticated;
GRANT INSERT (baby_id, share_link_id, event, metadata) ON public.audit_log TO pipeline;

DROP POLICY IF EXISTS audit_log_authenticated_select ON public.audit_log;
CREATE POLICY audit_log_authenticated_select ON public.audit_log FOR SELECT TO authenticated
  USING (public.is_baby_admin(baby_id) OR actor_user_id = public.auth_uid());
DROP POLICY IF EXISTS audit_log_authenticated_insert ON public.audit_log;
CREATE POLICY audit_log_authenticated_insert ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_user_id = public.auth_uid() AND (baby_id IS NULL OR public.is_baby_member(baby_id)));
DROP POLICY IF EXISTS audit_log_pipeline_insert ON public.audit_log;
CREATE POLICY audit_log_pipeline_insert ON public.audit_log FOR INSERT TO pipeline
  WITH CHECK (actor_user_id IS NULL);

-- Down Migration

DROP TABLE IF EXISTS public.audit_log;
DROP TABLE IF EXISTS public.chat_messages;
DROP TABLE IF EXISTS public.chat_threads;
DROP FUNCTION IF EXISTS public.chat_messages_thread_guard();
