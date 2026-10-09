import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { psql } from "./db";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const MAYA = "00000000-0000-4000-8000-000000000100";
const SEED_BATCH = "00000000-0000-4000-8000-000000000500";
const SEED_DESCRIBED_PHOTO = "00000000-0000-4000-8000-000000000304";
const DC = ["compose", "-f", "docker-compose.dev.yml"];

/**
 * Refuses to run unless this is the dev stack: the dev compose db is reachable, is named
 * `littlelight`, and holds the seeded demo baby. Throws loudly otherwise.
 */
export async function assertDevStack(): Promise<void> {
  const base = process.env.E2E_BASE_URL;
  if (base && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base)) {
    throw new Error(`e2e reset refuses to run against ${base}: the dev stack on localhost only`);
  }
  let rows: string[];
  try {
    rows = await psql(
      `select current_database() || '|' || (select count(*) from babies where id = '${MAYA}')`,
    );
  } catch (e) {
    throw new Error(
      `e2e reset: cannot reach the dev db through docker-compose.dev.yml (is the stack up?): ${e}`,
    );
  }
  if (rows[0] !== "littlelight|1") {
    throw new Error(
      `e2e reset: not the seeded dev DB (got ${JSON.stringify(rows[0])}); refusing to delete anything`,
    );
  }
}

/** Hard-deletes leftover test babies: never a seeded (0000...4000-8000-) baby, and only babies whose
 *  members are all `e2e-*@example.com` or seeded demo users. Cascades remove their photos, rows etc. */
export async function deleteLeftoverBabies(): Promise<number> {
  const rows = await psql(
    `with d as (delete from babies b where b.id::text not like '00000000-0000-4000-8000-%'
       and not exists (select 1 from baby_members m join auth.users u on u.id = m.user_id
         where m.baby_id = b.id and u.email !~ '^(e2e-.*@example\\.com|demo-.*@littlelight\\.local)$')
       returning 1) select count(*) from d`,
  );
  return Number(rows[0] ?? 0);
}

/**
 * Puts Maya's AI state back to the seed: only photo 304 keeps `photo_ai` / its batch item, no extra
 * batches, and the photos' status and `photo_search` rows are re-derived by re-running the idempotent
 * demo seed (the `migrate` one-shot). A worker flush (the push/share gates run one with
 * AI_BATCH_FLUSH_MINUTES=0) analyses Maya's ingested photos otherwise.
 */
export async function restoreMayaSeedState(): Promise<void> {
  await psql(
    `delete from ai_batch_items where baby_id = '${MAYA}' and batch_id <> '${SEED_BATCH}';
     delete from photo_ai where photo_id in (select id from photos where baby_id = '${MAYA}')
       and photo_id <> '${SEED_DESCRIBED_PHOTO}';
     delete from ai_batches b where b.id <> '${SEED_BATCH}'
       and not exists (select 1 from ai_batch_items i where i.batch_id = b.id);`,
  );
  await sh("docker", [...DC, "run", "--rm", "--no-deps", "migrate"], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Restarts the api (clears the in-memory sign-in throttle) and waits until the web proxy answers. */
export async function restartApi(): Promise<void> {
  await sh("bash", [".github/scripts/restart-api.sh"], { cwd: ROOT });
}

export async function resetDevState(): Promise<{ babies: number }> {
  await assertDevStack();
  const babies = await deleteLeftoverBabies();
  await restoreMayaSeedState();
  await restartApi();
  return { babies };
}
