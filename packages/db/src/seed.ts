/**
 * Demo-family seed (docs/plans/step-2.md 2.9). Dev only, idempotent, one transaction.
 *
 * Gate: runs only when `SEED_DEMO_FAMILY=true` and `NODE_ENV !== 'production'`. Without the flag
 * it exits 0 with "skipped" (so a production image that accidentally runs it does nothing); with
 * the flag in production it exits 1 without touching the database.
 *
 * Every row has a fixed id and is upserted, so any number of runs yields identical counts. No real
 * images are written: storage keys are placeholders. GPS / home coordinates are stored only
 * through `encrypt_coord`, with `DATA_ENCRYPTION_KEY` passed as a bind parameter
 * (`set_config('app.data_key', $1, true)`), never in statement text. Nothing here logs
 * coordinates, notes or keys; the only secret-looking thing printed is the fixed dev share token.
 *
 * GoTrue users are inserted straight into `auth.users` / `auth.identities` with the column list
 * in `test-support.ts` (`AUTH_USERS_STUB_SQL`); step 3's OTP e2e verifies GoTrue accepts them
 * (plan risk R1).
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { knownSecrets, requireDatabaseUrl, requireDataEncryptionKey, seedMode } from "./env.js";
import { describeError } from "./redact.js";

const { Client } = pg;

/** Fixed ids of the demo family. `@littlelight/shared` mirrors these as `DEMO_IDS`. */
export const DEMO = {
  users: {
    mom: "00000000-0000-4000-8000-000000000001",
    dad: "00000000-0000-4000-8000-000000000002",
    nanny: "00000000-0000-4000-8000-000000000003",
  },
  emails: {
    mom: "demo-mom@littlelight.local",
    dad: "demo-dad@littlelight.local",
    nanny: "demo-nanny@littlelight.local",
  },
  baby: "00000000-0000-4000-8000-000000000100",
  shareLink: "00000000-0000-4000-8000-000000000200",
  /** The completed demo `ai_batches` row behind the bath photo's `photo_ai` (step 6). */
  aiBatch: "00000000-0000-4000-8000-000000000500",
  /** Plaintext dev token; only its sha256 is stored. */
  shareToken: "demo-grandparents-share-token",
  /** Photo ids are `00000000-0000-4000-8000-0000000003NN`, NN = 01..12. */
  photo: (nn: number) => `00000000-0000-4000-8000-0000000003${String(nn).padStart(2, "0")}`,
  measurement: (nn: number) => `00000000-0000-4000-8000-0000000004${String(nn).padStart(2, "0")}`,
  identity: (nn: number) => `00000000-0000-4000-8000-0000000000${String(10 + nn).padStart(2, "0")}`,
  milestonePreset: (nn: number) =>
    `10000000-0000-4000-8000-0000000000${String(nn).padStart(2, "0")}`,
  birthDate: "2025-06-30",
} as const;

const PRESET = {
  firstSmile: DEMO.milestonePreset(1),
  firstSteps: DEMO.milestonePreset(8),
  firstBirthday: DEMO.milestonePreset(11),
} as const;

type UserKey = keyof typeof DEMO.users;

interface DemoPhoto {
  nn: number;
  uploadedBy: UserKey;
  takenAt: string; // ISO date-time (UTC)
  caption: string;
  tags: string[];
  approval: "approved" | "pending";
  deleted?: boolean;
  sensitive?: boolean;
  milestoneId?: string;
  people?: string[];
  locationLabel?: string;
  note?: string;
  /** Only one photo carries (encrypted) GPS; the value never appears in logs. */
  gps?: { lat: number; lng: number; placeLabel: string };
  mime: "image/jpeg" | "image/heic";
}

const PHOTOS: readonly DemoPhoto[] = [
  {
    nn: 1,
    uploadedBy: "mom",
    takenAt: "2025-07-04T15:12:00Z",
    caption: "Newborn asleep in a white blanket on the sofa.",
    tags: ["sleeping", "newborn", "indoor"],
    approval: "approved",
    mime: "image/heic",
  },
  {
    nn: 2,
    uploadedBy: "mom",
    takenAt: "2025-08-12T09:40:00Z",
    caption: "Maya smiles up at the camera from her changing mat.",
    tags: ["smiling", "indoor"],
    approval: "approved",
    milestoneId: PRESET.firstSmile,
    mime: "image/heic",
  },
  {
    nn: 3,
    uploadedBy: "dad",
    takenAt: "2025-09-20T16:05:00Z",
    caption: "Tummy time on a striped play mat, head lifted.",
    tags: ["tummy time", "indoor", "play mat"],
    approval: "approved",
    mime: "image/jpeg",
  },
  {
    nn: 4,
    uploadedBy: "mom",
    takenAt: "2025-11-02T18:30:00Z",
    caption: "Bath time in the baby tub, splashing.",
    tags: ["bath", "indoor"],
    approval: "approved",
    sensitive: true,
    mime: "image/heic",
  },
  {
    nn: 5,
    uploadedBy: "dad",
    takenAt: "2025-12-25T11:00:00Z",
    caption: "First Christmas in a red onesie next to the tree.",
    tags: ["christmas", "indoor", "family"],
    approval: "approved",
    people: ["Grandma Rose"],
    mime: "image/jpeg",
  },
  {
    nn: 6,
    uploadedBy: "mom",
    takenAt: "2026-02-14T14:20:00Z",
    caption: "Sitting up unassisted on the rug, holding a wooden rattle.",
    tags: ["sitting", "indoor", "toy"],
    approval: "approved",
    mime: "image/heic",
  },
  {
    nn: 7,
    uploadedBy: "dad",
    takenAt: "2026-04-10T12:00:00Z",
    caption: "Blurry shot in the stroller at the park.",
    tags: ["outdoor", "stroller"],
    approval: "approved",
    deleted: true,
    mime: "image/jpeg",
  },
  {
    nn: 8,
    uploadedBy: "mom",
    takenAt: "2026-05-01T10:15:00Z",
    caption: "Crawling across the kitchen floor toward the camera.",
    tags: ["crawling", "indoor", "kitchen"],
    approval: "approved",
    mime: "image/heic",
  },
  {
    nn: 9,
    uploadedBy: "dad",
    takenAt: "2026-06-14T15:30:00Z",
    caption:
      "Maya walks barefoot on grass toward Dad, arms out, smiling broadly; wearing a yellow sundress and white sun hat; sunny, outdoor.",
    tags: ["walking", "outdoor", "park", "grass", "sunny"],
    approval: "approved",
    milestoneId: PRESET.firstSteps,
    people: ["Dad"],
    locationLabel: "Riverside Park",
    note: "three wobbly steps then a fall into Dad's arms.",
    gps: { lat: 47.6097, lng: -122.3331, placeLabel: "Riverside Park" },
    mime: "image/jpeg",
  },
  {
    nn: 10,
    uploadedBy: "mom",
    takenAt: "2026-06-30T17:00:00Z",
    caption: "First birthday: a single candle on a small cake, hands reaching for it.",
    tags: ["birthday", "cake", "indoor", "family"],
    approval: "approved",
    milestoneId: PRESET.firstBirthday,
    people: ["Dad", "Grandma Rose"],
    mime: "image/heic",
  },
  {
    nn: 11,
    uploadedBy: "nanny",
    takenAt: "2026-06-20T11:10:00Z",
    caption: "Reading a picture book on the nanny's lap.",
    tags: ["reading", "indoor"],
    approval: "pending",
    mime: "image/jpeg",
  },
  {
    nn: 12,
    uploadedBy: "nanny",
    takenAt: "2026-06-22T16:45:00Z",
    caption: "Pushing a toy cart across the living room.",
    tags: ["walking", "toy", "indoor"],
    approval: "pending",
    mime: "image/jpeg",
  },
];

const COUNT_TABLES = [
  "profiles",
  "babies",
  "baby_members",
  "photos",
  "photo_exif",
  "photo_derivatives",
  "photo_details",
  "ai_batches",
  "ai_batch_items",
  "photo_ai",
  "measurements",
  "share_links",
  "share_rules",
  "shared_photos",
  "photo_search",
  "audit_log",
] as const;

export interface SeedOptions {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  dataEncryptionKey?: string;
  /** Defaults to console.log; receives already-redacted lines only. */
  log?: (line: string) => void;
}

export interface SeedResult {
  /** `count(*)` per seeded table after the run; identical on every run. */
  counts: Record<(typeof COUNT_TABLES)[number], number>;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

function ageDays(takenAt: string): number {
  const ms = Date.parse(takenAt.slice(0, 10)) - Date.parse(DEMO.birthDate);
  return Math.floor(ms / 86_400_000);
}

function ageLabel(days: number): string {
  if (days < 0) return "before birth";
  const months = Math.floor(days / 30.4375);
  const weeks = Math.floor((days - months * 30.4375) / 7);
  if (months === 0) return weeks === 1 ? "1 week" : `${weeks} weeks`;
  const m = months === 1 ? "1 month" : `${months} months`;
  if (weeks === 0) return m;
  return `${m} ${weeks === 1 ? "1 week" : `${weeks} weeks`}`;
}

/**
 * Demo price-table numbers for the one described photo (docs/plans/step-6.md 2.3.9, 4.1):
 * 1,400 input tokens of which 700 cached, 400 output, gpt-6-luna batch tier; the per-photo
 * `cost_usd` is the PRD's ~$0.00017 estimate (`AI_COST_PER_PHOTO_ESTIMATE_USD`).
 */
const DEMO_AI = {
  provider: "openai",
  model: "gpt-6-luna",
  promptVersion: "v1",
  schemaVersion: "v1",
  providerBatchId: "batch_demo_littlelight_seed",
  inputTokens: 1400,
  cachedInputTokens: 700,
  outputTokens: 400,
  imageTokens: 519,
  costUsd: "0.00017",
} as const;

/**
 * The bath photo's structured description in the exact v1 shape (`aiDescriptionV1Schema` in
 * `@littlelight/shared`; a test parses this). Every key present, "absent" = null / [], closed
 * sets only, `sensitive_content` carries the flag that makes the photo sensitive.
 */
function bathDescriptionV1(p: DemoPhoto): Record<string, unknown> {
  return {
    caption: p.caption,
    detailed_description:
      "A baby sits in a small plastic baby tub with shallow water, splashing with both hands so that droplets are caught mid-air. A yellow rubber duck floats beside the baby and a folded towel lies within reach on the edge of the tub. The room is bright and warm-toned.",
    subjects: [{ who: "baby", relation_hint: null, is_target_baby: true }],
    baby_present: true,
    baby_state: { pose: "sitting", expression: "smiling", activity: "splashing in the bath" },
    setting: { indoor_outdoor: "indoor", place_type: "bathroom", weather: null, time_of_day: null },
    objects: ["baby tub", "rubber duck", "towel"],
    clothing: [],
    activities: ["bathing", "splashing"],
    possible_milestones: [{ name: "Sat up", confidence: 0.92 }],
    occasion: null,
    mood: ["playful", "happy"],
    colors: ["white", "yellow", "blue"],
    text_in_image: null,
    photo_quality: { blurry: false, is_screenshot: false, is_duplicate_like: false },
    sensitive_content: ["bath"],
    search_tags: [
      "bath",
      "bath time",
      "baby tub",
      "splashing",
      "rubber duck",
      "bathroom",
      "indoor",
      "sitting",
      "smiling",
      "water",
    ],
  };
}

function searchText(p: DemoPhoto, milestoneName: string | undefined, relationship: string): string {
  const parts: string[] = [`Maya, ${ageLabel(ageDays(p.takenAt))} (${p.takenAt.slice(0, 10)})`];
  if (p.locationLabel) parts[0] += ` at ${p.locationLabel}`;
  parts[0] += ".";
  if (milestoneName) parts.push(`Milestone: ${milestoneName.toLowerCase()}.`);
  if (p.people?.length) parts.push(`With ${p.people.join(" and ")}.`);
  parts.push(p.caption);
  if (p.note) parts.push(`Note from ${relationship}: '${p.note}'`);
  return parts.join(" ");
}

/** Seed the demo family. Caller is responsible for the dev-only gate (see `seedFromEnv`). */
export async function seed(options: SeedOptions = {}): Promise<SeedResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl(env);
  const dataKey = options.dataEncryptionKey ?? requireDataEncryptionKey(env);
  const secrets = [dataKey, ...knownSecrets(env)];

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "littlelight-seed",
  });
  try {
    await client.connect();
    await client.query("BEGIN");
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

    const ready = await q(
      "SELECT to_regclass('auth.users') IS NOT NULL AS auth_ok, to_regclass('public.photo_search') IS NOT NULL AS schema_ok",
    );
    if (!ready.rows[0]?.auth_ok) {
      throw new Error("auth.users is missing: start the auth (GoTrue) service before seeding");
    }
    if (!ready.rows[0]?.schema_ok) {
      throw new Error("schema is missing: run pnpm db:migrate before seeding");
    }

    // Transaction-local key for encrypt_coord (bind parameter; never part of statement text).
    await q("SELECT set_config('app.data_key', $1, true)", [dataKey]);

    // --- GoTrue users + identities ------------------------------------------------------------
    const users: { key: UserKey; display: string; relationship: string; nn: number }[] = [
      { key: "mom", display: "Maria", relationship: "Mom", nn: 1 },
      { key: "dad", display: "Daniel", relationship: "Dad", nn: 2 },
      { key: "nanny", display: "Nadia", relationship: "Nanny", nn: 3 },
    ];
    for (const u of users) {
      const id = DEMO.users[u.key];
      const email = DEMO.emails[u.key];
      await q(
        `INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
           confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current,
           phone_change, phone_change_token, reauthentication_token, raw_app_meta_data, raw_user_meta_data,
           is_sso_user, is_anonymous, created_at, updated_at)
         VALUES ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, NULL, now(),
           '', '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
           false, false, now(), now())
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
        [id, email],
      );
      await q(
        `INSERT INTO auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
         VALUES ($1, $2, 'email', $3, jsonb_build_object('sub', $3::text, 'email', $4::text, 'email_verified', true), now(), now(), now())
         ON CONFLICT (id) DO UPDATE SET identity_data = EXCLUDED.identity_data, updated_at = now()`,
        [DEMO.identity(u.nn), id, id, email],
      );
      await q(
        `INSERT INTO public.profiles (user_id, display_name, relationship_label, timezone, units, terms_version, privacy_version, accepted_at, accepted_ip_country)
         VALUES ($1, $2, $3, 'America/Los_Angeles', 'metric', '2026-01', '2026-01', now(), 'US')
         ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, relationship_label = EXCLUDED.relationship_label,
           timezone = EXCLUDED.timezone, units = EXCLUDED.units, deleted_at = NULL`,
        [id, u.display, u.relationship],
      );
    }

    // --- Baby (creator trigger adds mom as admin on first insert) -------------------------------
    await q(
      `INSERT INTO public.babies (id, name, nickname, birth_date, birth_weight_g, birth_length_mm,
         home_lat_enc, home_lng_enc, home_label, plan, plan_owner_user_id, created_by)
       VALUES ($1, 'Maya', 'Mimi', $2::date, 3400, 510,
         public.encrypt_coord($3::double precision), public.encrypt_coord($4::double precision), 'Home', 'plus', $5, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, nickname = EXCLUDED.nickname, birth_date = EXCLUDED.birth_date,
         birth_weight_g = EXCLUDED.birth_weight_g, birth_length_mm = EXCLUDED.birth_length_mm,
         home_lat_enc = EXCLUDED.home_lat_enc, home_lng_enc = EXCLUDED.home_lng_enc, home_label = EXCLUDED.home_label,
         plan = EXCLUDED.plan, plan_owner_user_id = EXCLUDED.plan_owner_user_id, entitlement_expires_at = NULL, deleted_at = NULL`,
      [DEMO.baby, DEMO.birthDate, 47.6062, -122.3321, DEMO.users.mom],
    );
    for (const [key, role] of [
      ["mom", "admin"],
      ["dad", "admin"],
      ["nanny", "contributor"],
    ] as const) {
      await q(
        `INSERT INTO public.baby_members (baby_id, user_id, role, invited_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (baby_id, user_id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by`,
        [DEMO.baby, DEMO.users[key], role, key === "mom" ? null : DEMO.users.mom],
      );
    }

    // --- Photos and children -------------------------------------------------------------------
    const milestoneNames = new Map<string, string>();
    for (const row of (await q("SELECT id, name FROM public.milestones WHERE baby_id IS NULL"))
      .rows) {
      milestoneNames.set(row.id as string, row.name as string);
    }
    const relationshipOf = (key: UserKey) =>
      users.find((u) => u.key === key)?.relationship ?? "Parent";

    // The completed batch the bath photo's description came from (step 6): provider files
    // deleted, cost recorded. Inserted before the photos so photo_ai.batch_id can reference it.
    await q(
      `INSERT INTO public.ai_batches (id, provider, model, provider_batch_id, provider_input_file_id, provider_output_file_id,
         status, photo_count, submitted_at, completed_at, expires_at, last_polled_at, files_deleted_at,
         input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, image_tokens, cost_usd,
         prompt_version, schema_version, request_counts, submitted_bytes)
       VALUES ($1, $2, $3, $4, 'file-demo-input', 'file-demo-output',
         'completed', 1, now() - interval '2 hours', now() - interval '1 hour', now() + interval '22 hours',
         now() - interval '1 hour', now() - interval '1 hour',
         $5, $6, $7, 0, $8, $9::numeric, $10, $11, '{"total":1,"completed":1,"failed":0}'::jsonb, 92000)
       ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model,
         provider_batch_id = EXCLUDED.provider_batch_id, status = EXCLUDED.status, photo_count = EXCLUDED.photo_count,
         files_deleted_at = EXCLUDED.files_deleted_at, input_tokens = EXCLUDED.input_tokens,
         cached_input_tokens = EXCLUDED.cached_input_tokens, output_tokens = EXCLUDED.output_tokens,
         reasoning_tokens = EXCLUDED.reasoning_tokens, image_tokens = EXCLUDED.image_tokens, cost_usd = EXCLUDED.cost_usd,
         prompt_version = EXCLUDED.prompt_version, schema_version = EXCLUDED.schema_version,
         request_counts = EXCLUDED.request_counts, error = NULL`,
      [
        DEMO.aiBatch,
        DEMO_AI.provider,
        DEMO_AI.model,
        DEMO_AI.providerBatchId,
        DEMO_AI.inputTokens,
        DEMO_AI.cachedInputTokens,
        DEMO_AI.outputTokens,
        DEMO_AI.imageTokens,
        DEMO_AI.costUsd,
        DEMO_AI.promptVersion,
        DEMO_AI.schemaVersion,
      ],
    );

    for (const p of PHOTOS) {
      const id = DEMO.photo(p.nn);
      const key = `babies/${DEMO.baby}/originals/${id}.${p.mime === "image/heic" ? "heic" : "jpg"}`;
      const approved = p.approval === "approved";
      await q(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, sha256, width, height, bytes, mime,
           status, approval, approved_by, approved_at, taken_at, age_days, is_sensitive, deleted_at)
         VALUES ($1, $2, $3, $4, $5, 3024, 4032, 2480000, $6,
           $14, $7, $8, $9, $10::timestamptz, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET uploaded_by = EXCLUDED.uploaded_by, storage_key_original = EXCLUDED.storage_key_original,
           sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime, status = EXCLUDED.status, approval = EXCLUDED.approval,
           approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, taken_at = EXCLUDED.taken_at,
           age_days = EXCLUDED.age_days, is_sensitive = EXCLUDED.is_sensitive, deleted_at = EXCLUDED.deleted_at`,
        [
          id,
          DEMO.baby,
          DEMO.users[p.uploadedBy],
          key,
          sha256(`demo-photo-${p.nn}`),
          p.mime,
          p.approval,
          approved ? DEMO.users.mom : null,
          approved ? p.takenAt : null,
          p.takenAt,
          ageDays(p.takenAt),
          p.sensitive === true,
          p.deleted ? new Date(Date.now() - 3 * 86_400_000) : null,
          // The described photo is `ready` (its photo_ai row below); every other one is ingested.
          p.sensitive ? "ready" : "ingested",
        ],
      );
      await q(
        `INSERT INTO public.photo_exif (photo_id, taken_at, tz_offset_minutes, gps_lat_enc, gps_lng_enc, place_label,
           camera_make, camera_model, orientation, raw_json)
         VALUES ($1, $2::timestamptz, -420, public.encrypt_coord($3::double precision), public.encrypt_coord($4::double precision), $5,
           'Apple', 'iPhone 16', 1, $6::jsonb)
         ON CONFLICT (photo_id) DO UPDATE SET taken_at = EXCLUDED.taken_at, gps_lat_enc = EXCLUDED.gps_lat_enc,
           gps_lng_enc = EXCLUDED.gps_lng_enc, place_label = EXCLUDED.place_label, raw_json = EXCLUDED.raw_json`,
        [
          id,
          p.takenAt,
          p.gps?.lat ?? null,
          p.gps?.lng ?? null,
          p.gps?.placeLabel ?? null,
          JSON.stringify({
            Make: "Apple",
            Model: "iPhone 16",
            DateTimeOriginal: p.takenAt,
            Orientation: 1,
          }),
        ],
      );
      for (const [kind, w, h, bytes] of [
        ["thumb", 300, 400, 24_000],
        ["display", 1536, 2048, 310_000],
      ] as const) {
        await q(
          `INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (photo_id, kind) DO UPDATE SET storage_key = EXCLUDED.storage_key, width = EXCLUDED.width,
             height = EXCLUDED.height, bytes = EXCLUDED.bytes`,
          [id, kind, `babies/${DEMO.baby}/derivatives/${id}/${kind}.jpg`, w, h, bytes],
        );
      }
      if (p.milestoneId || p.note || p.people || p.locationLabel) {
        await q(
          `INSERT INTO public.photo_details (photo_id, milestone_id, note, people, location_label, edited_by)
           VALUES ($1, $2, $3, $4::text[], $5, $6)
           ON CONFLICT (photo_id) DO UPDATE SET milestone_id = EXCLUDED.milestone_id, note = EXCLUDED.note,
             people = EXCLUDED.people, location_label = EXCLUDED.location_label, edited_by = EXCLUDED.edited_by`,
          [
            id,
            p.milestoneId ?? null,
            p.note ?? null,
            p.people ?? [],
            p.locationLabel ?? null,
            DEMO.users[p.uploadedBy],
          ],
        );
      }
      if (p.sensitive) {
        // The description row; the photo itself was inserted as `ready` above.
        await q(
          `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description, sensitive_flags, confidence,
             batch_id, input_tokens, output_tokens)
           VALUES ($1, $2, $3, $4, $5::jsonb, '{bath}'::text[], 0.92, $6, $7, $8)
           ON CONFLICT (photo_id) DO UPDATE SET model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version,
             schema_version = EXCLUDED.schema_version, description = EXCLUDED.description,
             sensitive_flags = EXCLUDED.sensitive_flags, confidence = EXCLUDED.confidence, batch_id = EXCLUDED.batch_id,
             input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens`,
          [
            id,
            DEMO_AI.model,
            DEMO_AI.promptVersion,
            DEMO_AI.schemaVersion,
            JSON.stringify(bathDescriptionV1(p)),
            DEMO.aiBatch,
            DEMO_AI.inputTokens,
            DEMO_AI.outputTokens,
          ],
        );
        await q(
          `INSERT INTO public.ai_batch_items (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state,
             input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, image_tokens, cost_usd, created_at)
           VALUES ($1, $2, $3, 1, $4, $5, 'succeeded', $6, $7, $8, 0, $9, $10::numeric, now() - interval '2 hours')
           ON CONFLICT (batch_id, photo_id) DO UPDATE SET state = EXCLUDED.state, failure_kind = NULL,
             attempt = EXCLUDED.attempt, prompt_version = EXCLUDED.prompt_version, schema_version = EXCLUDED.schema_version,
             input_tokens = EXCLUDED.input_tokens, cached_input_tokens = EXCLUDED.cached_input_tokens,
             output_tokens = EXCLUDED.output_tokens, reasoning_tokens = EXCLUDED.reasoning_tokens,
             image_tokens = EXCLUDED.image_tokens, cost_usd = EXCLUDED.cost_usd`,
          [
            DEMO.aiBatch,
            id,
            DEMO.baby,
            DEMO_AI.promptVersion,
            DEMO_AI.schemaVersion,
            DEMO_AI.inputTokens,
            DEMO_AI.cachedInputTokens,
            DEMO_AI.outputTokens,
            DEMO_AI.imageTokens,
            DEMO_AI.costUsd,
          ],
        );
      }
      if (approved && !p.deleted) {
        const milestoneName = p.milestoneId ? milestoneNames.get(p.milestoneId) : undefined;
        await q(
          // No vector, no doc_version, no content_hash: the worker's search.reconcile rebuilds
          // and embeds these rows (docs/plans/step-7.md 2.3.9). A re-seed resets the bookkeeping
          // too, so a worker-built row never keeps a hash/vector that no longer matches the text.
          `INSERT INTO public.photo_search (photo_id, baby_id, search_text, taken_at, age_days, milestone_ids, people, tags,
             is_sensitive, place)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6::uuid[], $7::text[], $8::text[], $9, $10)
           ON CONFLICT (photo_id) DO UPDATE SET search_text = EXCLUDED.search_text, taken_at = EXCLUDED.taken_at,
             age_days = EXCLUDED.age_days, milestone_ids = EXCLUDED.milestone_ids, people = EXCLUDED.people,
             tags = EXCLUDED.tags, is_sensitive = EXCLUDED.is_sensitive, place = EXCLUDED.place,
             embedding = NULL, embed_model = NULL, doc_version = NULL, content_hash = NULL, embedded_at = NULL`,
          [
            id,
            DEMO.baby,
            searchText(p, milestoneName, relationshipOf(p.uploadedBy)),
            p.takenAt,
            ageDays(p.takenAt),
            p.milestoneId ? [p.milestoneId] : [],
            p.people ?? [],
            p.tags,
            p.sensitive === true,
            // The FR-7.5 place chip: the parents' label wins over the EXIF label; never coordinates.
            (p.locationLabel ?? p.gps?.placeLabel)?.toLowerCase() ?? null,
          ],
        );
      }
    }
    await q(
      "UPDATE public.babies SET avatar_photo_id = $2 WHERE id = $1 AND avatar_photo_id IS DISTINCT FROM $2",
      [DEMO.baby, DEMO.photo(2)],
    );

    // --- Measurements (metric: grams / millimetres) --------------------------------------------
    for (const [nn, kind, metric, entered, unit, at, photoNn] of [
      [1, "weight", 3400, 3.4, "kg", "2025-06-30T12:00:00Z", 1],
      [2, "weight", 6500, 6.5, "kg", "2025-10-30T12:00:00Z", null],
      [3, "height", 660, 66, "cm", "2025-12-30T12:00:00Z", null],
    ] as const) {
      await q(
        `INSERT INTO public.measurements (id, baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)
         ON CONFLICT (id) DO UPDATE SET photo_id = EXCLUDED.photo_id, kind = EXCLUDED.kind, value_metric = EXCLUDED.value_metric,
           value_entered = EXCLUDED.value_entered, unit_entered = EXCLUDED.unit_entered, measured_at = EXCLUDED.measured_at`,
        [
          DEMO.measurement(nn),
          DEMO.baby,
          photoNn ? DEMO.photo(photoNn) : null,
          kind,
          metric,
          entered,
          unit,
          at,
          DEMO.users.mom,
        ],
      );
    }

    // --- Share link (always fresh: expires 24 h from this run), rule, shared photos ------------
    // A revoked link can only come back with a new token (`share_links_lifecycle`, step-8 D13),
    // and the demo token is fixed: a revoked demo link is deleted (cascading its sessions, rule,
    // album and exclusions) and recreated below.
    await q("DELETE FROM public.share_links WHERE id = $1 AND revoked_at IS NOT NULL", [
      DEMO.shareLink,
    ]);
    await q(
      `INSERT INTO public.share_links (id, baby_id, name, token_hash, passcode_hash, expires_at, ttl_hours, allow_download, revoked_at, created_by)
       VALUES ($1, $2, 'Grandparents', $3, NULL, now() + interval '24 hours', 24, false, NULL, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, token_hash = EXCLUDED.token_hash, passcode_hash = NULL,
         expires_at = EXCLUDED.expires_at, ttl_hours = EXCLUDED.ttl_hours, allow_download = EXCLUDED.allow_download,
         revoked_at = NULL`,
      [DEMO.shareLink, DEMO.baby, sha256(DEMO.shareToken), DEMO.users.mom],
    );
    await q(
      `INSERT INTO public.share_rules (share_link_id, mode) VALUES ($1, 'milestones')
       ON CONFLICT (share_link_id) DO UPDATE SET mode = EXCLUDED.mode, include_tags = '{}', exclude_tags = '{}'`,
      [DEMO.shareLink],
    );
    // Hand-picked by mom. Photo 4 (bath, sensitive) is shared but not released ("Show to family"
    // off): viewers get a hidden tile with no image and cannot read its derivatives (step-8 D4).
    for (const nn of [2, 4, 9, 10]) {
      await q(
        "DELETE FROM public.shared_photo_exclusions WHERE share_link_id = $1 AND photo_id = $2",
        [DEMO.shareLink, DEMO.photo(nn)],
      );
      await q(
        `INSERT INTO public.shared_photos (share_link_id, photo_id, added_by, added_by_user_id, sensitive_released_at, sensitive_released_by)
         VALUES ($1, $2, 'user', $3, NULL, NULL)
         ON CONFLICT (share_link_id, photo_id) DO UPDATE SET added_by = EXCLUDED.added_by, added_by_user_id = EXCLUDED.added_by_user_id,
           sensitive_released_at = NULL, sensitive_released_by = NULL`,
        [DEMO.shareLink, DEMO.photo(nn), DEMO.users.mom],
      );
    }

    // --- Audit (identity id: insert once, never update) -----------------------------------------
    await q(
      `INSERT INTO public.audit_log (baby_id, actor_user_id, event, metadata)
       SELECT $1, $2, 'seed.demo_family', '{"source":"packages/db/src/seed.ts"}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM public.audit_log WHERE baby_id = $1 AND event = 'seed.demo_family')`,
      [DEMO.baby, DEMO.users.mom],
    );

    const counts = {} as SeedResult["counts"];
    for (const table of COUNT_TABLES) {
      const { rows } = await q(`SELECT count(*)::int AS n FROM public.${table}`);
      counts[table] = (rows[0] as { n: number }).n;
    }
    await client.query("COMMIT");

    log(`seed: demo family upserted: ${COUNT_TABLES.map((t) => `${t}=${counts[t]}`).join(" ")}`);
    log(`seed: dev share token (dev only, fixed): ${DEMO.shareToken}`);
    return { counts };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the original error is what matters
    }
    throw new Error(`seed failed: ${describeError(err, secrets)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * CLI entry with the dev-only gate. Resolves with the exit code: 0 for skipped/done, 1 for refused.
 */
export async function seedFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  switch (seedMode(env)) {
    case "skip":
      log("seed: skipped (SEED_DEMO_FAMILY not set)");
      return 0;
    case "refuse":
      log("seed: refusing to seed the demo family with NODE_ENV=production");
      return 1;
    case "run":
      await seed({ env, log });
      return 0;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  seedFromEnv()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(describeError(err, knownSecrets()));
      process.exit(1);
    });
}
