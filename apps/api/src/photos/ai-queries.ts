import {
  AI_FIELD_OVERRIDABLE,
  type AiFailureKind,
  type AiOverrideField,
  aiDescriptionV1Schema,
  aiFailureKindSchema,
  aiOverrideValueSchema,
  applyAiOverrides,
  type PhotoAi,
  type PhotoAiOverridePatch,
  type PhotoAiOverrides,
  type PhotoAiStatus,
} from "@tinyglow/shared";
import type { Tx } from "../auth";
import { AI_STATUS_SQL, toAiStatus } from "./queries";

// AI reads and writes of the API (docs/plans/step-6.md 2.8; PRD FR-5.6 "parent overrides win",
// FR-5.8 paid tier only). The API never calls a model and never reads a provider key: it only
// reads what the worker stored (`photo_ai`, `ai_batch_items`) and writes the caller's own
// overrides / retry flag, all under the caller's claims so RLS decides (`photo_visible` for
// reads, `photo_editable` for override writes, the `photos` UPDATE policy for the retry flag).
// Descriptions and override values are user content: never logged, never audited.

/** `photo_ai` columns the `ai` block needs (no tokens, no batch id). */
interface PhotoAiRow {
  model: string;
  prompt_version: string;
  schema_version: string;
  description: unknown;
  updated_at: Date;
}

/**
 * Current overrides of one photo, keyed by field. Rows whose field is not overridable or whose
 * value does not satisfy the field's value schema are ignored (the DB's shape trigger rejects
 * both since step 6; older rows could predate it).
 */
export async function photoAiOverrides(client: Tx, photoId: string): Promise<PhotoAiOverrides> {
  const { rows } = await client.query<{ field_path: string; value: unknown }>(
    "SELECT field_path, value FROM public.photo_ai_overrides WHERE photo_id = $1",
    [photoId],
  );
  const out: PhotoAiOverrides = {};
  for (const r of rows) {
    const field = AI_FIELD_OVERRIDABLE.find((f) => f === r.field_path);
    if (!field) continue;
    const parsed = aiOverrideValueSchema(field).safeParse(r.value);
    if (parsed.success) out[field] = parsed.data;
  }
  return out;
}

/** Category of the latest failed attempt of a photo (never a provider message). */
async function latestFailure(client: Tx, photoId: string): Promise<AiFailureKind | null> {
  const { rows } = await client.query<{ failure_kind: string | null }>(
    `SELECT failure_kind FROM public.ai_batch_items
      WHERE photo_id = $1 AND state = 'failed'
      ORDER BY created_at DESC LIMIT 1`,
    [photoId],
  );
  const parsed = aiFailureKindSchema.safeParse(rows[0]?.failure_kind);
  return parsed.success ? parsed.data : null;
}

/** Inputs of the `ai` block that the photo row already carries. */
export interface AiBlockInput {
  photoId: string;
  /** `ai_status` of the photo row (`AI_STATUS_SQL`). */
  aiStatus: string | null | undefined;
  /** The caller is an admin of the photo's baby (`raw` and `canRetry` only for admins). */
  isAdmin: boolean;
}

/**
 * The `ai` block of `GET /photos/:id` (`photoAiSchema`), read in the caller's claims
 * transaction:
 * - `description` = `applyAiOverrides(photo_ai.description, overrides)` when `ready` and the
 *   stored row validates against `aiDescriptionV1Schema`; an old-version row that does not
 *   validate gives `description: null` with `status: ready` and its `schemaVersion`.
 * - `raw` = the stored model output without overrides, admins only.
 * - `failure` = the latest failed attempt's category, only while `status === "failed"`.
 * - `canRetry` = admin AND `status === "failed"`.
 */
export async function loadPhotoAi(client: Tx, input: AiBlockInput): Promise<PhotoAi> {
  const status = toAiStatus(input.aiStatus);
  const overrides = await photoAiOverrides(client, input.photoId);
  const block: PhotoAi = {
    status,
    description: null,
    raw: null,
    overrides,
    model: null,
    promptVersion: null,
    schemaVersion: null,
    analyzedAt: null,
    failure: null,
    canRetry: input.isAdmin && status === "failed",
  };
  if (status === "failed") block.failure = await latestFailure(client, input.photoId);
  if (status !== "ready") return block;

  const { rows } = await client.query<PhotoAiRow>(
    `SELECT model, prompt_version, schema_version, description, updated_at
       FROM public.photo_ai WHERE photo_id = $1`,
    [input.photoId],
  );
  const row = rows[0];
  if (!row) return block;
  block.model = row.model;
  block.promptVersion = row.prompt_version;
  block.schemaVersion = row.schema_version;
  block.analyzedAt = row.updated_at.toISOString();
  const parsed = aiDescriptionV1Schema.safeParse(row.description);
  if (!parsed.success) return block;
  block.description = applyAiOverrides(parsed.data, overrides);
  if (input.isAdmin) block.raw = parsed.data;
  return block;
}

/** The baby's AI entitlement (`baby_ai_enabled`: Plus, not expired, not trashed). */
export async function babyAiEnabled(client: Tx, babyId: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>("SELECT public.baby_ai_enabled($1) AS ok", [
    babyId,
  ]);
  return rows[0]?.ok === true;
}

/** One override change of `PATCH /photos/:id/ai`. */
export type OverrideChange =
  | { field: AiOverrideField; op: "set"; value: string | string[] }
  | { field: AiOverrideField; op: "clear" };

/** Provided keys of the PATCH body, in `AI_FIELD_OVERRIDABLE` order. Exported for tests. */
export function overrideChanges(patch: PhotoAiOverridePatch): OverrideChange[] {
  const out: OverrideChange[] = [];
  for (const field of AI_FIELD_OVERRIDABLE) {
    const v = patch[field];
    if (v === undefined) continue;
    out.push(v === null ? { field, op: "clear" } : { field, op: "set", value: v });
  }
  return out;
}

/**
 * Upsert one override under the caller's claims (RLS INSERT WITH CHECK / UPDATE USING =
 * `photo_editable`; a refusal is 42501). The value is a bind parameter (JSON), never logged.
 */
export async function setOverride(
  client: Tx,
  photoId: string,
  uid: string,
  field: AiOverrideField,
  value: string | string[],
): Promise<void> {
  await client.query(
    `INSERT INTO public.photo_ai_overrides AS o (photo_id, field_path, value, edited_by)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (photo_id, field_path)
       DO UPDATE SET value = EXCLUDED.value, edited_by = EXCLUDED.edited_by`,
    [photoId, field, JSON.stringify(value), uid],
  );
}

/** Delete one override; true when a row was removed (RLS DELETE USING = `photo_editable`). */
export async function clearOverride(
  client: Tx,
  photoId: string,
  field: AiOverrideField,
): Promise<boolean> {
  const { rowCount } = await client.query(
    "DELETE FROM public.photo_ai_overrides WHERE photo_id = $1 AND field_path = $2",
    [photoId, field],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * `POST /photos/:id/ai/retry`: set `ai_retry_requested_at` only when the photo is live,
 * `ingested` and its derived status is `failed`. RLS (`photos_authenticated_update`) limits the
 * write to admins (and uploaders of their own pending photos, which are never `failed`). Returns
 * the photo's baby id, or null when no row matched (the caller explains why).
 */
export async function requestAiRetry(client: Tx, photoId: string): Promise<string | null> {
  const { rows } = await client.query<{ baby_id: string }>(
    `UPDATE public.photos p SET ai_retry_requested_at = now()
      WHERE p.id = $1 AND p.deleted_at IS NULL AND p.status = 'ingested'
        AND (${AI_STATUS_SQL}) = 'failed'
      RETURNING p.baby_id`,
    [photoId],
  );
  return rows[0]?.baby_id ?? null;
}

// ---- usage ---------------------------------------------------------------------------------------

/** Counts by status, every key present. */
export type AiStatusCounts = Record<PhotoAiStatus, number>;

const emptyCounts = (): AiStatusCounts => ({
  not_available: 0,
  pending: 0,
  queued: 0,
  analyzing: 0,
  ready: 0,
  failed: 0,
});

/** Live approved album photos (the usage endpoint's population). */
const USAGE_POPULATION = `p.baby_id = $1 AND p.deleted_at IS NULL AND p.approval = 'approved'
       AND p.status NOT IN ('failed', 'duplicate')`;

export interface AiUsageRows {
  costUsd: number;
  counts: AiStatusCounts;
  lastCompletedAt: Date | null;
}

/**
 * `GET /babies/:id/ai/usage` reads under the caller's claims: `ai_baby_month_cost_usd` (SECURITY
 * INVOKER, so RLS on `ai_batch_items` applies), counts by `AI_STATUS_SQL` over live approved
 * photos (a baby without AI entitlement counts everything as `not_available` in one cheap
 * count), and the latest succeeded attempt. `monthStart` is `YYYY-MM-01` (UTC month).
 */
export async function aiUsage(
  client: Tx,
  babyId: string,
  monthStart: string,
): Promise<AiUsageRows> {
  const { rows: costRows } = await client.query<{
    cost: string | null;
    enabled: boolean;
    last: Date | null;
  }>(
    `SELECT public.ai_baby_month_cost_usd($1, $2::date)::text AS cost,
            public.baby_ai_enabled($1) AS enabled,
            (SELECT max(i.updated_at) FROM public.ai_batch_items i
              WHERE i.baby_id = $1 AND i.state = 'succeeded') AS last`,
    [babyId, monthStart],
  );
  const head = costRows[0];
  const counts = emptyCounts();
  if (head?.enabled) {
    const { rows } = await client.query<{ s: string; n: number }>(
      `SELECT s.s, count(*)::int AS n
         FROM (SELECT ${AI_STATUS_SQL} AS s FROM public.photos p WHERE ${USAGE_POPULATION}) s
        GROUP BY s.s`,
      [babyId],
    );
    for (const r of rows) counts[toAiStatus(r.s)] += r.n;
  } else {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.photos p WHERE ${USAGE_POPULATION}`,
      [babyId],
    );
    counts.not_available = rows[0]?.n ?? 0;
  }
  const cost = Number(head?.cost ?? 0);
  return {
    costUsd: Number.isFinite(cost) && cost > 0 ? cost : 0,
    counts,
    lastCompletedAt: head?.last ?? null,
  };
}
