import { fileURLToPath } from "node:url";
import {
  CopyObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  babyPrefix,
  DEMO_IDS,
  derivativeKey,
  MILESTONE_PRESETS,
  originalKey,
  PERF_IDS,
  PERF_MEASUREMENT_COUNT,
  PERF_PHOTO_COUNT,
} from "@tinyglow/shared";
import pg from "pg";
import { errorCategory } from "../clients";
import { CACHE_CONTROL } from "../ingest";
import { createStorage } from "../storage";
import {
  PERF_BABY_NAME,
  PERF_BABY_NICKNAME,
  PERF_BIRTH_DATE,
  PERF_CUSTOM_MILESTONES,
  PERF_OWNER,
  PERF_TZ_OFFSET_MINUTES,
  type PerfPhoto,
  perfDetails,
  perfMeasurements,
  perfPhotos,
} from "./perf-content";
import {
  PERF_DERIVATIVE_KINDS,
  type PerfBaseImage,
  perfBaseKey,
  perfBasePrefix,
  renderPerfBases,
} from "./perf-images";

// Dev-only performance seed (docs/plans/step-5.md 2.8, D6): a free-tier baby "Pixel" with 10,000
// ingested photos, real thumb/display derivatives in MinIO, milestones, details and measurements.
//
// Family (step 11, migration 21's family model, docs/plans/step-11.md 2.6, D-G): Pixel is its own
// perf family, free, far over the cap; the owner never signs in; mom/dad are guests. The perf
// owner (`PERF_OWNER`, a GoTrue user with no password) creates it and is its only parent (an
// account is a parent in one family only, and demo-mom and demo-dad are parents of the demo
// family); demo-mom and demo-dad are contributors, so the perf check signing in as mom still sees
// the timeline and album. `family_id` is passed explicitly and pinned on every run (a dev DB
// backfilled by migration 21 has Pixel merged into the demo family through demo-mom's old admin
// row: a re-run re-homes it). `--remove` deletes the baby (`babies_release_family` drops its
// family), then the perf owner.
//
//   pnpm perf:seed              # seed (idempotent: a re-run copies nothing and prints the same counts)
//   pnpm perf:seed --force      # re-copy every per-photo object (old versions are deleted first)
//   pnpm perf:seed --remove     # delete every object version under the baby's prefix, then the rows
//
// Runs on the HOST against the dev stack with the Postgres superuser and the MinIO root key,
// never in a container or image. Refuses NODE_ENV=production, any database or S3 host that is
// not localhost, and any database user other than `postgres`. Defaults (override with env):
//   DATABASE_URL=postgres://postgres:dev@localhost:${DB_PORT:-5432}/tinyglow
//   S3_ENDPOINT=http://localhost:${STORAGE_PORT:-9000} S3_ACCESS_KEY=dev S3_SECRET_KEY=devdevdev
//   S3_BUCKET=tinyglow-dev  PERF_SEED_CONCURRENCY=32
//
// 48 base images (24 months x thumb/display) are rendered once through the worker's real
// `renderDerivative` and uploaded to `babies/<perf>/derivatives/_base/`; every photo's keys are
// server-side `CopyObject`s of its month's base (no bytes over the wire). No `analysis`
// derivative, no original object, no GPS, no `encrypt_coord`. The baby is `plus` only while the
// photo rows are inserted (the free-tier cap trigger) and ends `free` with no plan owner in the
// same transaction, so nothing of it can ever be sent to a model. (Free, it is far over the
// 1,000-photo cap: the perf owner can never add to it, which the perf gate does not need.)
// Output is counts and timings only: never notes, people, keys with signatures or credentials.

const { Client } = pg;

/** A failure whose message is safe to print (ours: no URLs, keys, notes or names). */
export class PerfSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfSeedError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BATCH = 1000;

export interface PerfSeedTarget {
  databaseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  concurrency: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function envOr(env: Env, key: string, fallback: string): string {
  const v = env[key]?.trim();
  return v ? v : fallback;
}

/** Target from env, with dev-stack defaults derived from `DB_PORT` / `STORAGE_PORT`. */
export function resolvePerfSeedTarget(env: Env = process.env): PerfSeedTarget {
  const dbPort = envOr(env, "DB_PORT", "5432");
  const storagePort = envOr(env, "STORAGE_PORT", "9000");
  const concurrency = Number.parseInt(envOr(env, "PERF_SEED_CONCURRENCY", "32"), 10);
  return {
    databaseUrl: envOr(env, "DATABASE_URL", `postgres://postgres:dev@localhost:${dbPort}/tinyglow`),
    s3Endpoint: envOr(env, "S3_ENDPOINT", `http://localhost:${storagePort}`),
    s3Region: envOr(env, "S3_REGION", "us-east-1"),
    s3AccessKey: envOr(env, "S3_ACCESS_KEY", "dev"),
    s3SecretKey: envOr(env, "S3_SECRET_KEY", "devdevdev"),
    s3Bucket: envOr(env, "S3_BUCKET", "tinyglow-dev"),
    concurrency:
      Number.isInteger(concurrency) && concurrency >= 1 ? Math.min(concurrency, 128) : 32,
  };
}

/**
 * Why the seed must not run against this target, or null when it may. Messages name the rule,
 * never the URL (it carries a password).
 */
export function perfSeedRefusal(target: PerfSeedTarget, env: Env = process.env): string | null {
  if (env.NODE_ENV?.trim() === "production") {
    return "refusing to run with NODE_ENV=production (the perf seed is dev only)";
  }
  let db: URL;
  try {
    db = new URL(target.databaseUrl);
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  if (db.protocol !== "postgres:" && db.protocol !== "postgresql:") {
    return "DATABASE_URL must be a postgres:// URL";
  }
  if (!LOCAL_HOSTS.has(db.hostname.toLowerCase())) {
    return "DATABASE_URL host must be localhost or 127.0.0.1 (the seed runs on the host against the dev stack)";
  }
  for (const param of ["host", "hostaddr", "port"]) {
    if (db.searchParams.has(param)) return `DATABASE_URL must not set ?${param}=`;
  }
  if (decodeURIComponent(db.username) !== "postgres") {
    return "DATABASE_URL user must be the dev superuser `postgres`";
  }
  let s3: URL;
  try {
    s3 = new URL(target.s3Endpoint);
  } catch {
    return "S3_ENDPOINT is not a valid URL";
  }
  if (s3.protocol !== "http:" && s3.protocol !== "https:") {
    return "S3_ENDPOINT must be an http(s) URL";
  }
  if (!LOCAL_HOSTS.has(s3.hostname.toLowerCase())) {
    return "S3_ENDPOINT host must be localhost or 127.0.0.1 (the seed runs on the host against the dev stack)";
  }
  return null;
}

// --- helpers ---------------------------------------------------------------------------------------

type Log = (line: string) => void;

function ms(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++] as T;
        try {
          await fn(item);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    }),
  );
}

interface ListedObject {
  etag: string;
  size: number;
}

/** Current objects under `prefix` (paginated). */
async function listObjects(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<Map<string, ListedObject>> {
  const out = new Map<string, ListedObject>();
  let token: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.set(o.Key, { etag: o.ETag ?? "", size: o.Size ?? -1 });
    }
    if (!res.IsTruncated || !res.NextContinuationToken) return out;
    token = res.NextContinuationToken;
  }
  return out;
}

/** Number of object versions + delete markers under `prefix`, and the max versions of any key. */
async function countVersions(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<{ versions: number; keys: number; maxPerKey: number }> {
  const perKey = new Map<string, number>();
  let versions = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const res = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        MaxKeys: 1000,
      }),
    );
    for (const v of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
      if (!v.Key) continue;
      versions++;
      perKey.set(v.Key, (perKey.get(v.Key) ?? 0) + 1);
    }
    if (!res.IsTruncated) break;
    keyMarker = res.NextKeyMarker;
    versionIdMarker = res.NextVersionIdMarker;
  }
  return { versions, keys: perKey.size, maxPerKey: Math.max(0, ...perKey.values()) };
}

function createS3(target: PerfSeedTarget): S3Client {
  return new S3Client({
    endpoint: target.s3Endpoint,
    region: target.s3Region,
    forcePathStyle: true,
    credentials: { accessKeyId: target.s3AccessKey, secretAccessKey: target.s3SecretKey },
  });
}

async function connect(target: PerfSeedTarget): Promise<pg.Client> {
  const client = new Client({
    connectionString: target.databaseUrl,
    application_name: "tinyglow-perf-seed",
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new PerfSeedError(
      `cannot connect to Postgres (${errorCategory(err)}): is the dev stack up (DB_PORT / DATABASE_URL)?`,
    );
  }
  return client;
}

// --- preflight ----------------------------------------------------------------------------------

async function preflight(db: pg.Client, s3: S3Client, bucket: string): Promise<void> {
  const { rows } = await db.query<{
    superuser: string;
    step5: boolean;
    step11: boolean;
    demo_users: number;
  }>(
    `SELECT current_setting('is_superuser') AS superuser,
            to_regprocedure('public.age_group(integer)') IS NOT NULL AS step5,
            (to_regclass('public.families') IS NOT NULL
              AND EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name = 'babies'
                             AND column_name = 'family_id')) AS step11,
            (SELECT count(*)::int FROM public.profiles WHERE user_id = ANY($1::uuid[]) AND deleted_at IS NULL) AS demo_users`,
    [[DEMO_IDS.users.mom, DEMO_IDS.users.dad]],
  );
  const r = rows[0];
  if (r?.superuser !== "on")
    throw new PerfSeedError("the database user must be a superuser (postgres)");
  if (!r.step5)
    throw new PerfSeedError("schema is behind: run pnpm db:migrate (step-5 migration missing)");
  if (!r.step11)
    throw new PerfSeedError(
      "schema is behind: run pnpm db:migrate (step-11 families migration missing)",
    );
  if (r.demo_users !== 2) {
    throw new PerfSeedError(
      "demo mom/dad not found: run the demo seed first (SEED_DEMO_FAMILY=true pnpm db:seed, or start the dev stack)",
    );
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    throw new PerfSeedError(
      `bucket ${bucket} is not reachable (${errorCategory(err)}): is the dev stack up?`,
    );
  }
}

// --- rows -------------------------------------------------------------------------------------

// The perf owner: a GoTrue user (same column list as the demo seed, packages/db/src/seed.ts) with
// no password, plus its identity and a consented profile. Never signs in.
const UPSERT_OWNER_USER_SQL = `
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token, raw_app_meta_data, raw_user_meta_data,
  is_sso_user, is_anonymous, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, NULL, now(),
  '', '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  false, false, now(), now())
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`;

const UPSERT_OWNER_IDENTITY_SQL = `
INSERT INTO auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
VALUES ($1, $2::uuid, 'email', $2::uuid::text,
  jsonb_build_object('sub', $2::uuid::text, 'email', $3::text, 'email_verified', true), NULL, now(), now())
ON CONFLICT (id) DO UPDATE SET identity_data = EXCLUDED.identity_data, updated_at = now()`;

const UPSERT_OWNER_PROFILE_SQL = `
INSERT INTO public.profiles (user_id, display_name, relationship_label, timezone, units, terms_version, privacy_version, accepted_at, accepted_ip_country)
VALUES ($1, $2, NULL, 'America/Los_Angeles', 'metric', '2026-01', '2026-01', now(), NULL)
ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, deleted_at = NULL,
  suspended_at = NULL, suspended_reason = NULL`;

// The perf family: Pixel's current family when no other baby shares it, else the perf owner's
// family under the same condition, else NULL (the caller inserts a new one). A dev DB backfilled
// by migration 21 holds Pixel in the demo family (shared admin demo-mom): never reuse that one.
const PERF_FAMILY_SQL = `
SELECT f.id
  FROM (SELECT b.family_id AS id, 1 AS rank FROM public.babies b WHERE b.id = $1
        UNION ALL
        SELECT public.parent_family_of($2::uuid), 2) AS f
 WHERE f.id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.babies o WHERE o.family_id = f.id AND o.id <> $1)
 ORDER BY f.rank
 LIMIT 1`;

const INSERT_FAMILY_SQL = `INSERT INTO public.families (created_by) VALUES ($1) RETURNING id`;

// created_by is the perf owner and family_id the perf family, on insert (an explicit family_id
// bypasses the creator lookup of babies_set_family) AND on a re-run over an older Pixel.
const UPSERT_BABY_SQL = `
INSERT INTO public.babies (id, name, nickname, birth_date, birth_weight_g, birth_length_mm,
  home_lat_enc, home_lng_enc, home_label, plan, plan_owner_user_id, entitlement_expires_at, created_by,
  family_id, deleted_at)
VALUES ($1, $2, $3, $4::date, 3300, 500, NULL, NULL, NULL, 'plus', NULL, NULL, $5, $6, NULL)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, nickname = EXCLUDED.nickname,
  birth_date = EXCLUDED.birth_date, birth_weight_g = EXCLUDED.birth_weight_g,
  birth_length_mm = EXCLUDED.birth_length_mm, home_lat_enc = NULL, home_lng_enc = NULL,
  home_label = NULL, plan = 'plus', plan_owner_user_id = NULL, entitlement_expires_at = NULL,
  created_by = EXCLUDED.created_by, family_id = EXCLUDED.family_id, deleted_at = NULL`;

const UPSERT_MEMBER_SQL = `
INSERT INTO public.baby_members (baby_id, user_id, role, invited_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (baby_id, user_id) DO UPDATE SET role = EXCLUDED.role`;

const UPSERT_MILESTONE_SQL = `
INSERT INTO public.milestones (id, baby_id, name, category, sort_order, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order`;

const UPSERT_PHOTOS_SQL = `
INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, sha256, width, height,
  bytes, mime, status, approval, taken_at, taken_at_estimated, age_days, created_at,
  deleted_at, quarantined_at, duplicate_of_photo_id, is_sensitive)
SELECT u.id, $1::uuid, u.uploaded_by, u.key, u.sha256, u.width, u.height, u.bytes, 'image/jpeg',
  'ingested', 'approved', u.taken_at, false, u.age_days, u.created_at, NULL, NULL, NULL, false
FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::bytea[], $6::int[], $7::int[], $8::bigint[],
  $9::timestamptz[], $10::int[], $11::timestamptz[])
  AS u(id, uploaded_by, key, sha256, width, height, bytes, taken_at, age_days, created_at)
ON CONFLICT (id) DO UPDATE SET uploaded_by = EXCLUDED.uploaded_by,
  storage_key_original = EXCLUDED.storage_key_original, sha256 = EXCLUDED.sha256,
  width = EXCLUDED.width, height = EXCLUDED.height, bytes = EXCLUDED.bytes, mime = EXCLUDED.mime,
  status = EXCLUDED.status, approval = EXCLUDED.approval, approved_by = NULL, approved_at = NULL,
  taken_at = EXCLUDED.taken_at, taken_at_estimated = false, age_days = EXCLUDED.age_days,
  created_at = EXCLUDED.created_at, deleted_at = NULL, quarantined_at = NULL,
  duplicate_of_photo_id = NULL, is_sensitive = false
WHERE photos.baby_id = $1::uuid`;

const UPSERT_EXIF_SQL = `
INSERT INTO public.photo_exif (photo_id, taken_at, tz_offset_minutes, gps_lat_enc, gps_lng_enc,
  place_label, camera_make, camera_model, orientation, raw_json)
SELECT u.photo_id, u.taken_at, $1::smallint, NULL, NULL, NULL, u.make, u.model, 1,
  jsonb_build_object('Make', u.make, 'Model', u.model, 'Orientation', 1)
FROM unnest($2::uuid[], $3::timestamptz[], $4::text[], $5::text[]) AS u(photo_id, taken_at, make, model)
ON CONFLICT (photo_id) DO UPDATE SET taken_at = EXCLUDED.taken_at,
  tz_offset_minutes = EXCLUDED.tz_offset_minutes, gps_lat_enc = NULL, gps_lng_enc = NULL,
  place_label = NULL, camera_make = EXCLUDED.camera_make, camera_model = EXCLUDED.camera_model,
  orientation = EXCLUDED.orientation, raw_json = EXCLUDED.raw_json`;

const UPSERT_DERIVATIVES_SQL = `
INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
SELECT u.photo_id, u.kind, u.key, u.width, u.height, u.bytes
FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::int[], $6::bigint[])
  AS u(photo_id, kind, key, width, height, bytes)
ON CONFLICT (photo_id, kind) DO UPDATE SET storage_key = EXCLUDED.storage_key,
  width = EXCLUDED.width, height = EXCLUDED.height, bytes = EXCLUDED.bytes`;

const UPSERT_DETAILS_SQL = `
INSERT INTO public.photo_details (photo_id, milestone_id, note, people, location_label, edited_by)
SELECT u.photo_id, u.milestone_id, u.note, ARRAY(SELECT jsonb_array_elements_text(u.people)),
  u.location_label, $1::uuid
FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::jsonb[], $6::text[])
  AS u(photo_id, milestone_id, note, people, location_label)
ON CONFLICT (photo_id) DO UPDATE SET milestone_id = EXCLUDED.milestone_id, note = EXCLUDED.note,
  people = EXCLUDED.people, location_label = EXCLUDED.location_label, edited_by = EXCLUDED.edited_by`;

const UPSERT_MEASUREMENT_SQL = `
INSERT INTO public.measurements (id, baby_id, photo_id, kind, value_metric, value_entered,
  unit_entered, measured_at, note, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)
ON CONFLICT (id) DO UPDATE SET photo_id = EXCLUDED.photo_id, kind = EXCLUDED.kind,
  value_metric = EXCLUDED.value_metric, value_entered = EXCLUDED.value_entered,
  unit_entered = EXCLUDED.unit_entered, measured_at = EXCLUDED.measured_at, note = NULL
WHERE measurements.baby_id = EXCLUDED.baby_id`;

export interface PerfSeedCounts {
  photos: number;
  photo_derivatives: number;
  photo_details: number;
  measurements: number;
  custom_milestones: number;
  members: number;
}

async function countRows(db: pg.Client, babyId: string): Promise<PerfSeedCounts> {
  const { rows } = await db.query<PerfSeedCounts>(
    `SELECT
       (SELECT count(*)::int FROM public.photos WHERE baby_id = $1) AS photos,
       (SELECT count(*)::int FROM public.photo_derivatives d JOIN public.photos p ON p.id = d.photo_id WHERE p.baby_id = $1) AS photo_derivatives,
       (SELECT count(*)::int FROM public.photo_details d JOIN public.photos p ON p.id = d.photo_id WHERE p.baby_id = $1) AS photo_details,
       (SELECT count(*)::int FROM public.measurements WHERE baby_id = $1) AS measurements,
       (SELECT count(*)::int FROM public.milestones WHERE baby_id = $1) AS custom_milestones,
       (SELECT count(*)::int FROM public.baby_members WHERE baby_id = $1) AS members`,
    [babyId],
  );
  return rows[0] as PerfSeedCounts;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function writeRows(
  db: pg.Client,
  photos: readonly PerfPhoto[],
  bases: ReadonlyMap<string, PerfBaseImage>,
): Promise<void> {
  const baby = PERF_IDS.baby;
  const owner = PERF_OWNER.userId;
  const mom = DEMO_IDS.users.mom;
  const dad = DEMO_IDS.users.dad;
  await db.query("BEGIN");
  try {
    // A perf id must never belong to another baby (a different seed or a hand-made row).
    const clash = await db.query(
      `SELECT 1 FROM public.photos WHERE id >= $1::uuid AND id <= $2::uuid AND baby_id <> $3 LIMIT 1`,
      [PERF_IDS.photo(0), PERF_IDS.photo(PERF_PHOTO_COUNT - 1), baby],
    );
    if (clash.rowCount)
      throw new PerfSeedError("a perf photo id belongs to another baby; refusing");

    // The perf owner account (creator and only parent of Pixel).
    await db.query(UPSERT_OWNER_USER_SQL, [owner, PERF_OWNER.email]);
    await db.query(UPSERT_OWNER_IDENTITY_SQL, [PERF_OWNER.identityId, owner, PERF_OWNER.email]);
    await db.query(UPSERT_OWNER_PROFILE_SQL, [owner, PERF_OWNER.displayName]);

    // The perf family, reused when it is Pixel's alone, else a new one founded by the owner.
    const reuse = await db.query<{ id: string }>(PERF_FAMILY_SQL, [baby, owner]);
    const family =
      reuse.rows[0]?.id ?? (await db.query<{ id: string }>(INSERT_FAMILY_SQL, [owner])).rows[0]?.id;
    if (!family) throw new PerfSeedError("could not create the perf family");

    // Members: the owner the only admin, mom and dad guests. Order matters over an older Pixel
    // (admins mom + dad from step 5, or owner + mom): baby_members_max_two_admins and
    // baby_members_keep_last_admin need dad to step down first, then the owner to be an admin,
    // then mom to step down. baby_members_one_family only checks rows becoming admin (the
    // owner's, whose only album is Pixel), so this order never trips it.
    const setMembers = async (): Promise<void> => {
      await db.query(UPSERT_MEMBER_SQL, [baby, dad, "contributor", owner]);
      await db.query(UPSERT_MEMBER_SQL, [baby, owner, "admin", null]);
      await db.query(UPSERT_MEMBER_SQL, [baby, mom, "contributor", owner]);
    };
    // An existing Pixel is re-homed by the upsert below (family_id = the perf family), and
    // babies_family_guard refuses that move while any admin of Pixel is a parent elsewhere
    // (demo-mom and demo-dad are parents of the demo family): demote them first. A new Pixel
    // needs its row before any member row (babies_add_creator_admin adds the owner as admin).
    const existing = await db.query("SELECT 1 FROM public.babies WHERE id = $1 FOR UPDATE", [baby]);
    const babyExists = (existing.rowCount ?? 0) > 0;
    if (babyExists) await setMembers();

    // `plus` only while the photos go in (photos_free_tier_cap); flipped back to free below.
    // babies_release_family drops Pixel's previous family if the move leaves it empty (it never
    // does: PERF_FAMILY_SQL reuses a family that holds Pixel alone).
    await db.query(UPSERT_BABY_SQL, [
      baby,
      PERF_BABY_NAME,
      PERF_BABY_NICKNAME,
      PERF_BIRTH_DATE,
      owner,
      family,
    ]);
    if (!babyExists) await setMembers();
    for (const m of PERF_CUSTOM_MILESTONES) {
      await db.query(UPSERT_MILESTONE_SQL, [m.id, baby, m.name, m.category, m.sortOrder, owner]);
    }

    for (const batch of chunks(photos, BATCH)) {
      const res = await db.query(UPSERT_PHOTOS_SQL, [
        baby,
        batch.map((p) => p.id),
        batch.map((p) => p.uploaderId),
        batch.map((p) => originalKey(baby, p.id)),
        batch.map((p) => p.sha256),
        batch.map((p) => p.width),
        batch.map((p) => p.height),
        batch.map((p) => p.bytes),
        batch.map((p) => p.takenAt),
        batch.map((p) => p.ageDays),
        batch.map((p) => p.createdAt),
      ]);
      if (res.rowCount !== batch.length)
        throw new PerfSeedError("a perf photo id belongs to another baby");
      await db.query(UPSERT_EXIF_SQL, [
        PERF_TZ_OFFSET_MINUTES,
        batch.map((p) => p.id),
        batch.map((p) => p.takenAt),
        batch.map((p) => p.cameraMake),
        batch.map((p) => p.cameraModel),
      ]);
      const ids: string[] = [];
      const kinds: string[] = [];
      const keys: string[] = [];
      const widths: number[] = [];
      const heights: number[] = [];
      const bytes: number[] = [];
      for (const p of batch) {
        for (const kind of PERF_DERIVATIVE_KINDS) {
          const base = bases.get(perfBaseKey(baby, kind, p.month));
          if (!base) throw new PerfSeedError("missing base image");
          ids.push(p.id);
          kinds.push(kind);
          keys.push(derivativeKey(baby, p.id, kind));
          widths.push(base.width);
          heights.push(base.height);
          bytes.push(base.bytes);
        }
      }
      await db.query(UPSERT_DERIVATIVES_SQL, [ids, kinds, keys, widths, heights, bytes]);
    }
    // Never an analysis derivative for the perf baby (free tier: nothing is ever analysed).
    await db.query(
      `DELETE FROM public.photo_derivatives d USING public.photos p
        WHERE p.id = d.photo_id AND p.baby_id = $1 AND d.kind = 'analysis'`,
      [baby],
    );

    const details = perfDetails(photos);
    for (const batch of chunks(details, BATCH)) {
      await db.query(UPSERT_DETAILS_SQL, [
        mom,
        batch.map((d) => d.photoId),
        batch.map((d) => d.milestoneId),
        batch.map((d) => d.note),
        batch.map((d) => JSON.stringify(d.people)),
        batch.map((d) => d.locationLabel),
      ]);
    }
    // Same set every run: drop details on perf photos that the content does not define.
    await db.query(
      `DELETE FROM public.photo_details d USING public.photos p
        WHERE p.id = d.photo_id AND p.baby_id = $1 AND NOT (d.photo_id = ANY($2::uuid[]))`,
      [baby, details.map((d) => d.photoId)],
    );

    const measurements = perfMeasurements(photos);
    for (const m of measurements) {
      const res = await db.query(UPSERT_MEASUREMENT_SQL, [
        m.id,
        baby,
        m.photoId,
        m.kind,
        m.valueMetric,
        m.valueEntered,
        m.unitEntered,
        m.measuredAt,
        mom,
      ]);
      if (res.rowCount !== 1)
        throw new PerfSeedError("a perf measurement id belongs to another baby");
    }

    // Avatar: the first-birthday photo (an approved, live photo of this baby).
    const birthday = MILESTONE_PRESETS.find((m) => m.name === "First birthday")?.id;
    const avatar = details.find((d) => d.milestoneId === birthday);
    await db.query("UPDATE public.babies SET avatar_photo_id = $2 WHERE id = $1", [
      baby,
      avatar?.photoId ?? null,
    ]);

    // End state: free plan, no owner (AI can never run on this baby; plan D6).
    await db.query(
      `UPDATE public.babies SET plan = 'free', plan_owner_user_id = NULL, entitlement_expires_at = NULL
        WHERE id = $1`,
      [baby],
    );
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

// --- objects ----------------------------------------------------------------------------------

async function uploadBases(
  s3: S3Client,
  bucket: string,
  bases: readonly PerfBaseImage[],
  force: boolean,
): Promise<{ uploaded: number; etags: Map<string, string> }> {
  const baby = PERF_IDS.baby;
  const storage = createStorage(s3, bucket);
  const existing = await listObjects(s3, bucket, perfBasePrefix(baby));
  const etags = new Map<string, string>();
  let uploaded = 0;
  for (const b of bases) {
    const key = perfBaseKey(baby, b.kind, b.month);
    const cur = existing.get(key);
    if (cur && cur.size === b.bytes && !force) {
      etags.set(key, cur.etag);
      continue;
    }
    // Keep exactly one version per key: drop the old versions before writing a new one.
    if (cur) await storage.deleteAllVersions(key);
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: b.buffer,
        ContentType: "image/jpeg",
        ContentLength: b.bytes,
        CacheControl: CACHE_CONTROL,
      }),
    );
    etags.set(key, res.ETag ?? "");
    uploaded++;
  }
  return { uploaded, etags };
}

async function copyDerivatives(
  s3: S3Client,
  target: PerfSeedTarget,
  photos: readonly PerfPhoto[],
  bases: ReadonlyMap<string, PerfBaseImage>,
  baseEtags: ReadonlyMap<string, string>,
  force: boolean,
): Promise<{ copied: number; skipped: number }> {
  const baby = PERF_IDS.baby;
  const bucket = target.s3Bucket;
  const storage = createStorage(s3, bucket);
  const existing = await listObjects(s3, bucket, `${babyPrefix(baby)}derivatives/`);
  const work: { key: string; source: string; replace: boolean }[] = [];
  let skipped = 0;
  for (const p of photos) {
    for (const kind of PERF_DERIVATIVE_KINDS) {
      const key = derivativeKey(baby, p.id, kind);
      const source = perfBaseKey(baby, kind, p.month);
      const cur = existing.get(key);
      const base = bases.get(source);
      const matches =
        cur !== undefined &&
        base !== undefined &&
        cur.size === base.bytes &&
        (cur.etag === "" || cur.etag === baseEtags.get(source));
      if (matches && !force) {
        skipped++;
        continue;
      }
      work.push({ key, source, replace: cur !== undefined });
    }
  }
  await mapLimit(work, target.concurrency, async (w) => {
    if (w.replace) await storage.deleteAllVersions(w.key);
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: w.key,
        CopySource: `${bucket}/${w.source}`,
        MetadataDirective: "COPY",
      }),
    );
  });
  return { copied: work.length, skipped };
}

// --- commands -----------------------------------------------------------------------------------

export async function runPerfSeed(
  target: PerfSeedTarget,
  opts: { force?: boolean; log?: Log } = {},
): Promise<PerfSeedCounts & { objects: number; baseObjects: number }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const force = opts.force === true;
  const t0 = performance.now();
  const s3 = createS3(target);
  const db = await connect(target);
  try {
    await preflight(db, s3, target.s3Bucket);

    let t = performance.now();
    const photos = perfPhotos();
    const baseList = await renderPerfBases();
    const bases = new Map(baseList.map((b) => [perfBaseKey(PERF_IDS.baby, b.kind, b.month), b]));
    log(`perf:seed: content + ${baseList.length} base images rendered in ${ms(t)}`);

    t = performance.now();
    const { uploaded, etags } = await uploadBases(s3, target.s3Bucket, baseList, force);
    const { copied, skipped } = await copyDerivatives(s3, target, photos, bases, etags, force);
    log(
      `perf:seed: objects: base uploaded=${uploaded} kept=${baseList.length - uploaded}, copies made=${copied} kept=${skipped} in ${ms(t)} (concurrency ${target.concurrency})`,
    );

    t = performance.now();
    await writeRows(db, photos, bases);
    // Fresh planner statistics so the timeline queries (and the perf gate) see 10,000 rows now
    // rather than after autovacuum gets to it.
    await db.query(
      "ANALYZE public.photos, public.photo_exif, public.photo_derivatives, public.photo_details, public.measurements",
    );
    log(`perf:seed: rows upserted in one transaction in ${ms(t)}`);

    const counts = await countRows(db, PERF_IDS.baby);
    const all = await listObjects(s3, target.s3Bucket, babyPrefix(PERF_IDS.baby));
    const basePrefix = perfBasePrefix(PERF_IDS.baby);
    const baseObjects = [...all.keys()].filter((k) => k.startsWith(basePrefix)).length;
    const objects = all.size - baseObjects;
    log(
      `perf:seed: photos=${counts.photos} photo_derivatives=${counts.photo_derivatives} photo_details=${counts.photo_details} measurements=${counts.measurements} milestones(custom)=${counts.custom_milestones} members=${counts.members} objects=${objects}+${baseObjects}`,
    );
    if (
      counts.photos !== PERF_PHOTO_COUNT ||
      counts.measurements !== PERF_MEASUREMENT_COUNT ||
      counts.photo_derivatives !== PERF_PHOTO_COUNT * PERF_DERIVATIVE_KINDS.length
    ) {
      log("perf:seed: WARNING counts differ from the expected 10000 / 20000 / 45");
    }
    log(`perf:seed: done in ${ms(t0)}`);
    return { ...counts, objects, baseObjects };
  } finally {
    await db.end().catch(() => undefined);
    s3.destroy();
  }
}

export async function removePerfSeed(
  target: PerfSeedTarget,
  opts: { log?: Log } = {},
): Promise<{
  versionsDeleted: number;
  versionsLeft: number;
  photosLeft: number;
  ownerLeft: number;
  /** 1 when Pixel's family row outlived it with no album left (the release trigger is missing). */
  familyLeft: number;
}> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const t0 = performance.now();
  const s3 = createS3(target);
  const db = await connect(target);
  try {
    const prefix = babyPrefix(PERF_IDS.baby);
    const versionsDeleted = await createStorage(s3, target.s3Bucket).deleteAllVersions(prefix);
    log(`perf:seed --remove: deleted ${versionsDeleted} object versions in ${ms(t0)}`);

    const t = performance.now();
    let family: string | null = null;
    await db.query("BEGIN");
    try {
      // Trash first so baby_members_keep_last_admin lets the cascade remove the admins.
      await db.query(
        "UPDATE public.babies SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
        [PERF_IDS.baby],
      );
      const fam = await db.query<{ family_id: string }>(
        "SELECT family_id FROM public.babies WHERE id = $1",
        [PERF_IDS.baby],
      );
      family = fam.rows[0]?.family_id ?? null;
      // babies_release_family drops the perf family with its last album.
      const del = await db.query("DELETE FROM public.babies WHERE id = $1", [PERF_IDS.baby]);
      // Then the perf owner (auth.users cascades to its identity and profile). Fixed id AND the
      // fixed email, so a real account can never match.
      const owner = await db.query("DELETE FROM auth.users WHERE id = $1 AND email = $2", [
        PERF_OWNER.userId,
        PERF_OWNER.email,
      ]);
      await db.query("COMMIT");
      log(
        `perf:seed --remove: deleted ${del.rowCount ?? 0} baby row (cascade) and ${owner.rowCount ?? 0} perf owner user in ${ms(t)}`,
      );
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    const left = await countRows(db, PERF_IDS.baby);
    const ownerLeft =
      (
        await db.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM auth.users WHERE id = $1)
                 + (SELECT count(*) FROM public.profiles WHERE user_id = $1))::int AS n`,
          [PERF_OWNER.userId],
        )
      ).rows[0]?.n ?? 0;
    const familyLeft = family
      ? ((
          await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM public.families f
              WHERE f.id = $1 AND NOT EXISTS (SELECT 1 FROM public.babies b WHERE b.family_id = f.id)`,
            [family],
          )
        ).rows[0]?.n ?? 0)
      : 0;
    const versions = await countVersions(s3, target.s3Bucket, prefix);
    log(
      `perf:seed --remove: photos=${left.photos} measurements=${left.measurements} milestones(custom)=${left.custom_milestones} perf_owner_rows=${ownerLeft} perf_family_rows=${familyLeft} object_versions=${versions.versions} in ${ms(t0)}`,
    );
    return {
      versionsDeleted,
      versionsLeft: versions.versions,
      photosLeft: left.photos,
      ownerLeft,
      familyLeft,
    };
  } finally {
    await db.end().catch(() => undefined);
    s3.destroy();
  }
}

/** Versions under the perf prefix after seeding (the gate wants exactly one per key). */
async function reportVersions(target: PerfSeedTarget, log: Log): Promise<void> {
  const s3 = createS3(target);
  try {
    const v = await countVersions(s3, target.s3Bucket, babyPrefix(PERF_IDS.baby));
    log(
      `perf:seed: object versions=${v.versions} keys=${v.keys} max versions per key=${v.maxPerKey}`,
    );
  } finally {
    s3.destroy();
  }
}

const USAGE = "usage: perf-seed [--remove | --force]";

export async function main(argv: string[], env: Env = process.env): Promise<number> {
  const args = new Set(argv.filter((a) => a !== "--"));
  for (const a of args) {
    if (a !== "--remove" && a !== "--force" && a !== "--help") {
      console.error(USAGE);
      return 2;
    }
  }
  if (args.has("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (args.has("--remove") && args.has("--force")) {
    console.error(USAGE);
    return 2;
  }
  const target = resolvePerfSeedTarget(env);
  const refusal = perfSeedRefusal(target, env);
  if (refusal) {
    console.error(`perf:seed: ${refusal}`);
    return 1;
  }
  const log: Log = (line) => console.log(line);
  try {
    if (args.has("--remove")) {
      const r = await removePerfSeed(target, { log });
      return r.versionsLeft === 0 && r.photosLeft === 0 && r.ownerLeft === 0 && r.familyLeft === 0
        ? 0
        : 1;
    }
    await runPerfSeed(target, { force: args.has("--force"), log });
    await reportVersions(target, log);
    return 0;
  } catch (err) {
    console.error(`perf:seed: failed: ${describeFailure(err)}`);
    return 1;
  }
}

/**
 * Printable reason: our own messages, a Postgres server error (SQLSTATE + message: server
 * messages name constraints, never row values), else the error category only (client/SDK
 * messages can echo connection strings or keys).
 */
export function describeFailure(err: unknown): string {
  if (err instanceof PerfSeedError) return err.message;
  if (err instanceof pg.DatabaseError) return `postgres ${err.code ?? "error"}: ${err.message}`;
  return errorCategory(err);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
