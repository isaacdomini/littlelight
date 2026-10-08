import pg from "pg";
import { loadHealthcheckConfig } from "./config";
import { workerId } from "./heartbeat";

// Container healthcheck (docs/plans/step-1.md 2.9). Exit 0 iff this worker's heartbeat row
// exists and `last_seen_at` is within HEARTBEAT_STALE_MS. The heartbeat only advances
// `last_seen_at` after a successful HeadBucket, so a fresh row also proves storage was reachable.
// Exit 1 otherwise. Never throws; prints a one-word reason, never connection details.

export const FRESH_SQL = `
SELECT (last_seen_at > now() - make_interval(secs => $2::double precision / 1000)) AS fresh
FROM worker_heartbeats
WHERE worker_id = $1`;

async function main(): Promise<number> {
  let config: ReturnType<typeof loadHealthcheckConfig>;
  try {
    config = loadHealthcheckConfig();
  } catch {
    console.error("unhealthy: invalid config");
    return 1;
  }
  const client = new pg.Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
    application_name: "littlelight-worker-healthcheck",
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ fresh: boolean }>(FRESH_SQL, [
      workerId(),
      config.HEARTBEAT_STALE_MS,
    ]);
    const row = rows[0];
    if (!row) {
      console.error("unhealthy: no heartbeat row");
      return 1;
    }
    if (!row.fresh) {
      console.error("unhealthy: stale heartbeat");
      return 1;
    }
    return 0;
  } catch {
    console.error("unhealthy: database unreachable");
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
