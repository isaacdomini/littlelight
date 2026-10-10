/**
 * Store-review family (docs/plans/step-9.md 2.9 item 6, 2.11; user decision D4, 2026-10-09).
 * App Review and Google Play "App access" need an account preloaded with sample (non-real) baby
 * photos (PRD "App store requirements"). This script gives an **existing** GoTrue user (the review
 * account signs up once through the normal email-code flow) a synthetic baby and nothing else:
 *
 *   DATABASE_URL=<superuser url> pnpm db:review-family --email <addr> [--confirm-production]   (host)
 *   docker compose -f docker-compose.dev.yml run --rm migrate pnpm db:review-family --email demo-dad@tinyglow.local
 *
 * What it writes, in one transaction with the superuser `DATABASE_URL` (like `db:plan`):
 * - baby "Sunny" (born 10 months before the first run; kept on re-runs), the user as admin,
 *   plan `plus` with `plan_owner_user_id` = the user (no billing; a manual grant like `db:plan`);
 * - 24 photo rows (`status = 'uploaded'`, approved, `image/jpeg`, originals at
 *   `babies/<babyId>/originals/<photoId>.jpg` like the demo seed, `created_at` spread over the 10
 *   months so ingest's no-EXIF fallback gives plausible ages). No bytes: `demo:media --review-baby
 *   <babyId>` (worker, 9.12) puts the illustrations there and enqueues the normal ingest pipeline.
 *   Keeping every object under the baby prefix means photo purge (`photoPrefixes`), baby purge
 *   (`babyPrefix`) and therefore account deletion (sole admin trashes the album first) remove them;
 * - parent details on a few photos (milestones First smile / First food / First steps, people
 *   "Grandma" and "Dad", short plain-English notes) and 4 measurements;
 * - audit rows `baby.created` and `baby.plan_changed` (`actor_user_id` NULL = operator).
 *
 * Every id is derived from the user id (`reviewId`), so re-runs update the same rows; photo rows
 * that already exist are left untouched (they may have been ingested and analysed since).
 *
 * Guards: refuses `NODE_ENV=production` without `--confirm-production`; refuses when the email has
 * no GoTrue user or no live profile; in production also refuses when the account belongs to any
 * other baby (the review sign-in must never open a real family). Output names ids and counts only:
 * never the email, a name, a note or a URL. The migrate image contains only this package: nothing
 * here may import another workspace package.
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import { isProduction, knownSecrets, requireDatabaseUrl } from "./env.js";
import { describeError } from "./redact.js";
import { reviewBabyId, reviewId, reviewPhotoId } from "./review-ids.js";

const { Client } = pg;

export const CONFIRM_PRODUCTION_FLAG = "--confirm-production";

export const REVIEW_USAGE = `usage: db:review-family --email <address> [${CONFIRM_PRODUCTION_FLAG}]`;

/** Same preset ids as the photos migration / `MILESTONE_PRESETS` (First smile, First food, First steps). */
const PRESET = {
  firstSmile: "10000000-0000-4000-8000-000000000001",
  firstFood: "10000000-0000-4000-8000-000000000005",
  firstSteps: "10000000-0000-4000-8000-000000000008",
} as const;

export const REVIEW_BABY_NAME = "Sunny";
export const REVIEW_PHOTO_COUNT = 24;
const BIRTH_MONTHS_AGO = 10;

interface ReviewPhoto {
  nn: number;
  /** Days after the birth date. */
  day: number;
  milestoneId?: string;
  people?: string[];
  note?: string;
}

/** 24 photos over the first ~10 months (max day 285 < 10 months, so never in the future). */
export const REVIEW_PHOTOS: readonly ReviewPhoto[] = [
  { nn: 1, day: 2, note: "Home from the hospital, wrapped in the striped blanket." },
  { nn: 2, day: 9 },
  { nn: 3, day: 16, people: ["Grandma"], note: "Grandma's first visit." },
  { nn: 4, day: 24 },
  { nn: 5, day: 33 },
  { nn: 6, day: 41 },
  {
    nn: 7,
    day: 52,
    milestoneId: PRESET.firstSmile,
    people: ["Dad"],
    note: "First real smile, right after the morning feed.",
  },
  { nn: 8, day: 60 },
  { nn: 9, day: 71 },
  { nn: 10, day: 83, people: ["Grandma"] },
  { nn: 11, day: 95 },
  { nn: 12, day: 108 },
  { nn: 13, day: 121 },
  { nn: 14, day: 135, people: ["Dad"] },
  { nn: 15, day: 149 },
  { nn: 16, day: 163 },
  {
    nn: 17,
    day: 178,
    milestoneId: PRESET.firstFood,
    note: "First taste of mashed sweet potato. Most of it ended up on the bib.",
  },
  { nn: 18, day: 192 },
  { nn: 19, day: 207, people: ["Grandma", "Dad"], note: "Sunday picnic in the garden." },
  { nn: 20, day: 221 },
  { nn: 21, day: 236 },
  { nn: 22, day: 251 },
  { nn: 23, day: 266 },
  {
    nn: 24,
    day: 285,
    milestoneId: PRESET.firstSteps,
    people: ["Dad"],
    note: "Three wobbly steps across the living room to Dad.",
  },
];

/** Metric values (grams / millimetres), measured `day` days after birth. */
const REVIEW_MEASUREMENTS = [
  { nn: 1, kind: "weight", metric: 3300, entered: 3.3, unit: "kg", day: 0 },
  { nn: 2, kind: "weight", metric: 5600, entered: 5.6, unit: "kg", day: 60 },
  { nn: 3, kind: "height", metric: 640, entered: 64, unit: "cm", day: 120 },
  { nn: 4, kind: "weight", metric: 7900, entered: 7.9, unit: "kg", day: 240 },
] as const;

// Id derivation lives in `review-ids.ts` (dependency-free, also exported as `@tinyglow/db/review`).
export { reviewBabyId, reviewId, reviewPhotoId };

/**
 * Original key the worker's `demo:media --review-baby` writes the illustration to: the seed's
 * pattern `babies/<babyId>/originals/<photoId>.jpg`. It must stay under `babies/<babyId>/` (and
 * start with `babies/<babyId>/originals/<photoId>`) so `purge.trash` deletes it with the photo or
 * the baby; a key outside the baby prefix would outlive both and account deletion.
 */
export function reviewOriginalKey(babyId: string, photoId: string): string {
  return `babies/${babyId}/originals/${photoId}.jpg`;
}

export interface ReviewFamilyArgs {
  email: string;
  confirmProduction: boolean;
}

/** Thrown for bad arguments (exit 2) as opposed to a refused or failed run (exit 1). */
export class ReviewUsageError extends Error {
  override readonly name = "ReviewUsageError";
}

// Deliberately loose (GoTrue already validated the address at sign-up); the lookup is exact.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function parseReviewFamilyArgs(argv: readonly string[]): ReviewFamilyArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let email: string | undefined;
  let confirmProduction = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === CONFIRM_PRODUCTION_FLAG) {
      confirmProduction = true;
    } else if (arg === "--email") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ReviewUsageError(`--email needs a value\n${REVIEW_USAGE}`);
      }
      i += 1;
      if (!EMAIL_RE.test(value)) throw new ReviewUsageError("--email must be an email address");
      email = value.trim().toLowerCase();
    } else {
      throw new ReviewUsageError(`unexpected argument\n${REVIEW_USAGE}`);
    }
  }
  if (email === undefined) throw new ReviewUsageError(REVIEW_USAGE);
  return { email, confirmProduction };
}

export interface ReviewFamilyOptions {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  /** Receives already-redacted lines (ids and counts only). */
  log?: (line: string) => void;
}

export interface ReviewFamilyResult {
  userId: string;
  babyId: string;
  /** Whether the baby row was created by this run. */
  babyCreated: boolean;
  photoIds: string[];
  /** Photo rows inserted by this run (0 on a re-run). */
  photosCreated: number;
  details: number;
  measurements: number;
  /** Memberships of the account in other babies (0 required in production). */
  otherBabies: number;
}

function addDays(isoDate: string, days: number, hourUtc = 17): Date {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** Create or refresh the review family. Throws (after ROLLBACK) on any refusal or failure. */
export async function provisionReviewFamily(
  args: ReviewFamilyArgs,
  options: ReviewFamilyOptions = {},
): Promise<ReviewFamilyResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const production = isProduction(env);
  if (production && !args.confirmProduction) {
    throw new Error(
      `refusing to provision a review family with NODE_ENV=production; pass ${CONFIRM_PRODUCTION_FLAG} once the user has approved it`,
    );
  }
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl(env);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "tinyglow-review-family",
  });
  try {
    await client.connect();
    await client.query("BEGIN");
    const q = <R extends pg.QueryResultRow = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ) => client.query<R>(sql, params);

    const ready = await q<{ auth_ok: boolean; schema_ok: boolean }>(
      "SELECT to_regclass('auth.users') IS NOT NULL AS auth_ok, to_regclass('public.push_devices') IS NOT NULL AS schema_ok",
    );
    if (!ready.rows[0]?.auth_ok) {
      throw new Error("auth.users is missing: start the auth (GoTrue) service first");
    }
    if (!ready.rows[0]?.schema_ok) {
      throw new Error("schema is missing: run pnpm db:migrate first");
    }

    // --- The account: an existing GoTrue user with a live profile ----------------------------
    const users = await q<{ id: string }>(
      "SELECT id FROM auth.users WHERE lower(email) = $1 AND is_sso_user = false",
      [args.email],
    );
    if (users.rowCount !== 1 || !users.rows[0]) {
      throw new Error(
        "no GoTrue user with that email: sign up once with it (email code) before provisioning",
      );
    }
    const userId = users.rows[0].id;
    const profile = await q(
      "SELECT 1 FROM public.profiles WHERE user_id = $1 AND deleted_at IS NULL",
      [userId],
    );
    if (profile.rowCount !== 1) {
      throw new Error(
        `user ${userId} has no live profile: sign in once in the app and accept the terms first`,
      );
    }

    const babyId = reviewBabyId(userId);
    const others = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.baby_members WHERE user_id = $1 AND baby_id <> $2",
      [userId, babyId],
    );
    const otherBabies = others.rows[0]?.n ?? 0;
    if (otherBabies > 0 && production) {
      throw new Error(
        `user ${userId} belongs to ${otherBabies} other baby(ies): the review account must own only the review family`,
      );
    }

    // --- Baby, membership, plan --------------------------------------------------------------
    const existing = await q<{ plan: string; plan_owner_user_id: string | null }>(
      "SELECT plan, plan_owner_user_id FROM public.babies WHERE id = $1 FOR UPDATE",
      [babyId],
    );
    const babyCreated = existing.rowCount === 0;
    const planChanged =
      babyCreated ||
      existing.rows[0]?.plan !== "plus" ||
      existing.rows[0]?.plan_owner_user_id !== userId;

    await q(
      `INSERT INTO public.babies (id, name, nickname, birth_date, birth_weight_g, birth_length_mm, plan,
         plan_owner_user_id, entitlement_expires_at, created_by)
       VALUES ($1, $2, NULL, (current_date - make_interval(months => $3))::date, 3300, 500, 'plus', $4, NULL, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan = 'plus', plan_owner_user_id = EXCLUDED.plan_owner_user_id,
         entitlement_expires_at = NULL, deleted_at = NULL`,
      [babyId, REVIEW_BABY_NAME, BIRTH_MONTHS_AGO, userId],
    );
    // The creator trigger adds the admin on first insert; a re-run restores it if it was changed.
    await q(
      `INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT (baby_id, user_id) DO UPDATE SET role = 'admin'`,
      [babyId, userId],
    );
    const baby = await q<{ birth_date: string; plan: string }>(
      "SELECT birth_date::text AS birth_date, plan FROM public.babies WHERE id = $1",
      [babyId],
    );
    const birthDate = baby.rows[0]?.birth_date;
    if (birthDate === undefined || baby.rows[0]?.plan !== "plus") {
      throw new Error(`review baby ${babyId} did not persist as plus`);
    }

    // --- Photos (existing rows untouched: they may be ingested and analysed by now) ----------
    const photoIds: string[] = [];
    let photosCreated = 0;
    let details = 0;
    for (const p of REVIEW_PHOTOS) {
      const photoId = reviewPhotoId(userId, p.nn);
      photoIds.push(photoId);
      const at = addDays(birthDate, p.day);
      const inserted = await q(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, mime, status, approval,
           approved_by, approved_at, taken_at, taken_at_estimated, age_days, created_at)
         VALUES ($1, $2, $3, $4, 'image/jpeg', 'uploaded', 'approved', $3, $5, $5, true, $6, $5)
         ON CONFLICT (id) DO NOTHING`,
        [photoId, babyId, userId, reviewOriginalKey(babyId, photoId), at, p.day],
      );
      photosCreated += inserted.rowCount ?? 0;
      if (p.milestoneId || p.people || p.note) {
        await q(
          `INSERT INTO public.photo_details (photo_id, milestone_id, note, people, location_label, edited_by)
           VALUES ($1, $2, $3, $4::text[], NULL, $5)
           ON CONFLICT (photo_id) DO UPDATE SET milestone_id = EXCLUDED.milestone_id, note = EXCLUDED.note,
             people = EXCLUDED.people, location_label = NULL, edited_by = EXCLUDED.edited_by`,
          [photoId, p.milestoneId ?? null, p.note ?? null, p.people ?? [], userId],
        );
        details += 1;
      }
    }

    // --- Measurements --------------------------------------------------------------------------
    for (const m of REVIEW_MEASUREMENTS) {
      await q(
        `INSERT INTO public.measurements (id, baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, value_metric = EXCLUDED.value_metric,
           value_entered = EXCLUDED.value_entered, unit_entered = EXCLUDED.unit_entered, measured_at = EXCLUDED.measured_at`,
        [
          reviewId(userId, `measurement:${m.nn}`),
          babyId,
          m.kind,
          m.metric,
          m.entered,
          m.unit,
          addDays(birthDate, m.day, 12),
          userId,
        ],
      );
    }

    // --- Audit (operator action: actor NULL; metadata keys from auditMetadataSchema) ----------
    if (babyCreated) {
      await q(
        `INSERT INTO public.audit_log (baby_id, actor_user_id, event, metadata)
         VALUES ($1, NULL, 'baby.created', $2::jsonb)`,
        [babyId, JSON.stringify({ target_user_id: userId })],
      );
    }
    if (planChanged) {
      await q(
        `INSERT INTO public.audit_log (baby_id, actor_user_id, event, metadata)
         VALUES ($1, NULL, 'baby.plan_changed', $2::jsonb)`,
        [babyId, JSON.stringify({ plan: "plus", target_user_id: userId })],
      );
    }

    await client.query("COMMIT");

    if (otherBabies > 0) {
      log(
        `db:review-family: warning: user ${userId} also belongs to ${otherBabies} other baby(ies) (allowed outside production only)`,
      );
    }
    log(
      `db:review-family: user ${userId} baby ${babyId} (${babyCreated ? "created" : "updated"}, plan plus): ` +
        `photos ${photoIds.length} (${photosCreated} new), details ${details}, measurements ${REVIEW_MEASUREMENTS.length}`,
    );
    log("db:review-family: next, write the illustrations and run the normal ingest:");
    log(
      production
        ? `  docker compose exec worker node apps/worker/dist/demo-media.js --review-baby ${babyId} --confirm-production`
        : `  docker compose -f docker-compose.dev.yml exec worker pnpm demo:media --review-baby ${babyId}`,
    );
    return {
      userId,
      babyId,
      babyCreated,
      photoIds,
      photosCreated,
      details,
      measurements: REVIEW_MEASUREMENTS.length,
      otherBabies,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the original error is what matters
    }
    throw new Error(`db:review-family failed: ${describeError(err, knownSecrets(env))}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** CLI entry. Exit codes: 0 done, 1 refused/failed, 2 usage. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let args: ReviewFamilyArgs;
  try {
    args = parseReviewFamilyArgs(argv);
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 2;
  }
  try {
    await provisionReviewFamily(args, { env, log });
    return 0;
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main().then((code) => process.exit(code));
}
