-- Up Migration

-- worker_heartbeats on the app role (docs/plans/step-2.md 2.4, 2.12; step-1 review item S5).
-- The worker now connects as littlelight_worker (not the superuser), so it needs a direct grant
-- and a policy. updated_at always advances on every beat (last_seen_at only while storage is
-- reachable), which gives the prune a safe "stale" signal.
ALTER TABLE public.worker_heartbeats ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_heartbeats FORCE ROW LEVEL SECURITY;

GRANT ALL ON public.worker_heartbeats TO littlelight_worker;
GRANT ALL ON public.worker_heartbeats TO service_role;

DROP POLICY IF EXISTS worker_heartbeats_worker_all ON public.worker_heartbeats;
CREATE POLICY worker_heartbeats_worker_all ON public.worker_heartbeats FOR ALL TO littlelight_worker
  USING (true) WITH CHECK (true);

-- Down Migration

DROP POLICY IF EXISTS worker_heartbeats_worker_all ON public.worker_heartbeats;
REVOKE ALL ON public.worker_heartbeats FROM littlelight_worker;
REVOKE ALL ON public.worker_heartbeats FROM service_role;
ALTER TABLE public.worker_heartbeats NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_heartbeats DROP COLUMN IF EXISTS updated_at;
