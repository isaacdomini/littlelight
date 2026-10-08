-- Up Migration

-- One row per worker container (worker_id = container hostname). The worker upserts its row only
-- when object storage is reachable; the container healthcheck reads its own row and fails when
-- last_seen_at is stale (docs/plans/step-1.md 2.9). Contains no user or baby data.
CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
  worker_id    text        PRIMARY KEY,
  hostname     text        NOT NULL,
  pid          integer     NOT NULL,
  version      text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  storage_ok   boolean     NOT NULL DEFAULT false,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.worker_heartbeats IS
  'Liveness rows written by pg-boss worker containers; operational data only, never user data.';

-- RLS is on from day one so that no non-owner role can read or write this table until an
-- explicit policy exists. In step 1 the api/worker connect as the table owner (superuser), which
-- bypasses RLS without FORCE. Step 2 introduces the app role and adds a policy for it here.
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;

-- Down Migration

DROP TABLE IF EXISTS public.worker_heartbeats;
