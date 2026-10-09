import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createFakeEmbedder, embedModelTag } from "@littlelight/ai";
import {
  buildSearchDocument,
  DEMO_IDS,
  EMBED_DIMS,
  originalKey,
  SEARCH_DOC_VERSION,
  SEARCH_SEED_IDS,
  SEARCH_SEED_MAX_PHOTOS,
} from "@littlelight/shared";
import pg from "pg";
import {
  goldenCollisions,
  SEARCH_SEED_BABY_NAME,
  SEARCH_SEED_BABY_NICKNAME,
  SEARCH_SEED_BIRTH_DATE,
  SEARCH_SEED_TZ_OFFSET_MINUTES,
  searchSeedMeasurements,
  searchSeedPhotos,
  seedDescription,
  seedMilestoneId,
} from "./search-content";
import {
  SEARCH_DOC_SQL,
  type SearchDocRow,
  toDocumentInput,
  UPSERT_SEARCH_SQL,
} from "./search-doc-sql";
import { sha256Hex } from "./search-index";

// Dev-only search seed (docs/plans/step-7.md 2.6, D11):
//
//   pnpm search:seed [--count 2000]     # default 2000; up to 100,000 (the perf target is 50,000)
//   pnpm search:seed --remove           # delete the Golden baby and everything under it
//
// The "Golden" baby (`SEARCH_SEED_IDS.baby`, plan `plus`, no plan owner, admins = the demo mom and
// dad) with `count` ready, approved photos (no objects in MinIO: `thumbUrl` is null in results),
// EXIF times (no GPS), parent details, schema-valid `photo_ai` rows (model `fake`, v1), 60
// measurements and the 50 planted golden targets (`search-content.ts`). `photo_search` is written
// directly as a FIXTURE, not by the pipeline: the rows are read back with the indexer's own
// `SEARCH_DOC_SQL`, mapped with its `toDocumentInput`, built with `buildSearchDocument`, embedded
// with the bag-of-words fake (`fake/1024`) and upserted with the indexer's `UPSERT_SEARCH_SQL`, so a
// later worker re-index finds identical hashes and does nothing.
//
// Runs on the HOST against the dev stack with the Postgres superuser. Refuses NODE_ENV=production,
// a non-local database host and any user other than `postgres`. Idempotent. Prints counts and
// timings only, never document text, notes or names.
//   DATABASE_URL=postgres://postgres:dev@localhost:${DB_PORT:-5432}/littlelight

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const CHUNK = 500;

function refusal(url: string, env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV?.trim() === "production") return "refusing to run with NODE_ENV=production";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) return "DATABASE_URL host must be localhost";
  if (decodeURIComponent(u.username) !== "postgres") return "DATABASE_URL user must be postgres";
  return null;
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;

export async function seed(db: pg.Client, count: number, log: (m: string) => void): Promise<void> {
  const t0 = performance.now();
  const baby = SEARCH_SEED_IDS.baby;
  const mom = DEMO_IDS.users.mom;
  const dad = DEMO_IDS.users.dad;
  const photos = searchSeedPhotos(count);
  const bad = goldenCollisions(photos);
  if (bad.length > 0) throw new Error(`golden collision in ${bad.length} distractors`);
  const ids = photos.map((p) => SEARCH_SEED_IDS.photo(p.index));

  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO public.babies (id, name, nickname, birth_date, plan, plan_owner_user_id,
                                  entitlement_expires_at, created_by, deleted_at)
       VALUES ($1, $2, $3, $4::date, 'plus', NULL, NULL, $5, NULL)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, nickname = EXCLUDED.nickname,
         birth_date = EXCLUDED.birth_date, plan = 'plus', plan_owner_user_id = NULL,
         entitlement_expires_at = NULL, deleted_at = NULL`,
      [baby, SEARCH_SEED_BABY_NAME, SEARCH_SEED_BABY_NICKNAME, SEARCH_SEED_BIRTH_DATE, mom],
    );
    for (const user of [mom, dad]) {
      await db.query(
        `INSERT INTO public.baby_members (baby_id, user_id, role, invited_by)
         VALUES ($1, $2, 'admin', $3) ON CONFLICT (baby_id, user_id) DO UPDATE SET role = 'admin'`,
        [baby, user, mom],
      );
    }
    // A smaller re-run drops the photos beyond `count` (cascade).
    await db.query("DELETE FROM public.photos WHERE baby_id = $1 AND NOT (id = ANY($2::uuid[]))", [
      baby,
      ids,
    ]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }

  let t = performance.now();
  for (const batch of chunks(photos, CHUNK)) {
    const bIds = batch.map((p) => SEARCH_SEED_IDS.photo(p.index));
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, sha256, width,
           height, bytes, mime, status, approval, taken_at, taken_at_estimated, age_days, created_at,
           deleted_at, quarantined_at, duplicate_of_photo_id, is_sensitive)
         SELECT u.id, $1::uuid, $2::uuid, u.key, u.sha, 1600, 1200, 400000, 'image/jpeg', 'ready',
                'approved', u.taken_at, false, u.age, u.taken_at + interval '1 hour', NULL, NULL,
                NULL, u.sensitive
         FROM unnest($3::uuid[], $4::text[], $5::bytea[], $6::timestamptz[], $7::int[], $8::boolean[])
           AS u(id, key, sha, taken_at, age, sensitive)
         ON CONFLICT (id) DO UPDATE SET status = 'ready', approval = 'approved',
           taken_at = EXCLUDED.taken_at, taken_at_estimated = false, age_days = EXCLUDED.age_days,
           created_at = EXCLUDED.created_at, deleted_at = NULL, quarantined_at = NULL,
           is_sensitive = EXCLUDED.is_sensitive`,
        [
          baby,
          mom,
          bIds,
          bIds.map((id) => originalKey(baby, id)),
          bIds.map((id) => createHash("sha256").update(`search-seed:${id}`).digest()),
          batch.map((p) => p.takenAt.toISOString()),
          batch.map((p) => p.ageDays),
          batch.map((p) => p.sensitive.length > 0),
        ],
      );
      await db.query(
        `INSERT INTO public.photo_exif (photo_id, taken_at, tz_offset_minutes, gps_lat_enc,
           gps_lng_enc, place_label, camera_make, camera_model, orientation, raw_json)
         SELECT u.id, u.taken_at, $1::smallint, NULL, NULL, NULL, 'Seed', 'Golden', 1, '{}'::jsonb
         FROM unnest($2::uuid[], $3::timestamptz[]) AS u(id, taken_at)
         ON CONFLICT (photo_id) DO UPDATE SET taken_at = EXCLUDED.taken_at,
           tz_offset_minutes = EXCLUDED.tz_offset_minutes, gps_lat_enc = NULL, gps_lng_enc = NULL,
           place_label = NULL, raw_json = '{}'::jsonb`,
        [SEARCH_SEED_TZ_OFFSET_MINUTES, bIds, batch.map((p) => p.takenAt.toISOString())],
      );
      const withDetails = batch.filter(
        (p) => p.people.length > 0 || p.milestone || p.note || p.place.label,
      );
      await db.query("DELETE FROM public.photo_details WHERE photo_id = ANY($1::uuid[])", [bIds]);
      if (withDetails.length > 0) {
        await db.query(
          `INSERT INTO public.photo_details (photo_id, milestone_id, note, people, location_label, edited_by)
           SELECT u.id, u.mid, u.note, ARRAY(SELECT jsonb_array_elements_text(u.people)), u.loc, $1::uuid
           FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::jsonb[], $6::text[])
             AS u(id, mid, note, people, loc)`,
          [
            mom,
            withDetails.map((p) => SEARCH_SEED_IDS.photo(p.index)),
            withDetails.map((p) => (p.milestone ? seedMilestoneId(p.milestone) : null)),
            withDetails.map((p) => p.note),
            withDetails.map((p) => JSON.stringify(p.people)),
            withDetails.map((p) => p.place.label),
          ],
        );
      }
      await db.query(
        `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
         SELECT u.id, 'fake', 'v1', 'v1', u.d
         FROM unnest($1::uuid[], $2::jsonb[]) AS u(id, d)
         ON CONFLICT (photo_id) DO UPDATE SET model = 'fake', prompt_version = 'v1',
           schema_version = 'v1', description = EXCLUDED.description`,
        [bIds, batch.map((p) => JSON.stringify(seedDescription(p)))],
      );
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }
  log(`search:seed: ${photos.length} photos, details and descriptions in ${ms(t)}`);

  t = performance.now();
  const measurements = searchSeedMeasurements();
  for (const m of measurements) {
    const unit = m.kind === "weight" ? "g" : "mm";
    await db.query(
      `INSERT INTO public.measurements (id, baby_id, photo_id, kind, value_metric, value_entered,
         unit_entered, measured_at, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, NULL, $8)
       ON CONFLICT (id) DO UPDATE SET photo_id = EXCLUDED.photo_id, kind = EXCLUDED.kind,
         value_metric = EXCLUDED.value_metric, value_entered = EXCLUDED.value_entered,
         unit_entered = EXCLUDED.unit_entered, measured_at = EXCLUDED.measured_at`,
      [
        SEARCH_SEED_IDS.measurement(m.index),
        baby,
        m.photoIndex === null ? null : SEARCH_SEED_IDS.photo(m.photoIndex),
        m.kind,
        m.valueMetric,
        unit,
        m.measuredAt.toISOString(),
        mom,
      ],
    );
  }
  log(`search:seed: ${measurements.length} measurements in ${ms(t)}`);

  // photo_search, through the indexer's own read + mapping + upsert (D11).
  t = performance.now();
  const embedder = createFakeEmbedder({ dims: EMBED_DIMS });
  const tag = embedModelTag(embedder);
  let written = 0;
  for (const batch of chunks(ids, CHUNK)) {
    const { rows } = await db.query<SearchDocRow>(SEARCH_DOC_SQL, [batch]);
    const docs = rows.map((r) => ({
      id: r.photo_id,
      doc: buildSearchDocument(toDocumentInput(r)),
    }));
    const { vectors } = await embedder.embed(docs.map((d) => d.doc.text));
    const up = await db.query(UPSERT_SEARCH_SQL, [
      docs.map((d) => d.id),
      docs.map((d) => d.doc.text),
      docs.map((d) => sha256Hex(d.doc.text)),
      docs.map((d) => d.doc.milestoneIds[0] ?? null),
      vectors.map((v) => `[${v.join(",")}]`),
      docs.map((d) => JSON.stringify(d.doc.people)),
      docs.map((d) => JSON.stringify(d.doc.tags)),
      docs.map((d) => d.doc.place),
      docs.map((d) => d.doc.isSensitive),
      tag,
      SEARCH_DOC_VERSION,
    ]);
    written += up.rowCount ?? 0;
  }
  log(`search:seed: photo_search=${written} (${tag}, ${SEARCH_DOC_VERSION}) in ${ms(t)}`);
  const { rows } = await db.query<{ photos: number; search: number }>(
    `SELECT (SELECT count(*) FROM public.photos WHERE baby_id = $1)::int AS photos,
            (SELECT count(*) FROM public.photo_search WHERE baby_id = $1)::int AS search`,
    [baby],
  );
  log(
    `search:seed: done in ${ms(t0)}: baby=${baby} photos=${rows[0]?.photos} photo_search=${rows[0]?.search}`,
  );
}

export async function remove(db: pg.Client, log: (m: string) => void): Promise<void> {
  const t0 = performance.now();
  await db.query("BEGIN");
  try {
    // Trash first so the last-admin trigger lets the cascade remove the admins.
    await db.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [
      SEARCH_SEED_IDS.baby,
    ]);
    const del = await db.query("DELETE FROM public.babies WHERE id = $1", [SEARCH_SEED_IDS.baby]);
    await db.query("COMMIT");
    log(`search:seed --remove: deleted ${del.rowCount ?? 0} baby row (cascade) in ${ms(t0)}`);
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

const USAGE = "usage: search-seed [--count N] [--remove]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let count = 2000;
  let removeOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--remove") removeOnly = true;
    else if (a === "--count") {
      count = Number(args[++i]);
      if (!Number.isInteger(count) || count < 50 || count > SEARCH_SEED_MAX_PHOTOS) {
        throw new Error(`--count must be an integer in 50..${SEARCH_SEED_MAX_PHOTOS}`);
      }
    } else if (a === "--") continue;
    else throw new Error(USAGE);
  }
  const url =
    process.env.DATABASE_URL?.trim() ||
    `postgres://postgres:dev@localhost:${process.env.DB_PORT?.trim() || "5432"}/littlelight`;
  const why = refusal(url, process.env);
  if (why) throw new Error(why);
  const db = new pg.Client({ connectionString: url, application_name: "littlelight-search-seed" });
  await db.connect();
  try {
    if (removeOnly) await remove(db, console.log);
    else await seed(db, count, console.log);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    // Our messages only (no URLs, notes or names); pg errors print their SQLSTATE.
    const code = (err as { code?: unknown })?.code;
    console.error(
      `search:seed failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}${typeof code === "string" ? ` (${code})` : ""}`,
    );
    process.exit(1);
  });
}
