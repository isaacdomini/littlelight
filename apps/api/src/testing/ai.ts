import { randomUUID } from "node:crypto";
import { fakeDescription } from "@littlelight/ai";
import type { AiDescriptionV1 } from "@littlelight/shared";
import type pg from "pg";

// Superuser fixtures for the AI tests (apps/api integration). Test-only.

/** A schema-valid description, deterministic per seed. */
export function sampleDescription(seed = "00000000-0000-4000-8000-000000000001"): AiDescriptionV1 {
  return fakeDescription(seed.replace(/^0/, "a"));
}

/** An `ai_batches` row (items need one); returns its id. */
export async function seedBatch(admin: pg.Client): Promise<string> {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO public.ai_batches (id, provider, model, status) VALUES ($1, 'fake', 'gpt-6-luna', 'completed')",
    [id],
  );
  return id;
}

/** The `photo_ai` row of a photo (description stored as given: pass junk to test old rows). */
export async function seedPhotoAi(
  admin: pg.Client,
  photoId: string,
  description: unknown = sampleDescription(photoId),
  versions: { prompt?: string; schema?: string } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
     VALUES ($1, 'gpt-6-luna', $2, $3, $4::jsonb)`,
    [photoId, versions.prompt ?? "v1", versions.schema ?? "v1", JSON.stringify(description)],
  );
}

/** One `ai_batch_items` row (the guard needs an approved, live photo of a paid baby). */
export async function seedItem(
  admin: pg.Client,
  o: {
    /** Default: a fresh batch (the primary key is batch + photo, so each attempt needs its own). */
    batchId?: string;
    photoId: string;
    babyId: string;
    attempt?: number;
    state?: "pending" | "submitted" | "succeeded" | "failed" | "dropped";
    failure?: string | null;
    prompt?: string;
    schema?: string;
    /** SQL interval ago, e.g. "2 hours". */
    ago?: string;
    cost?: number | null;
  },
): Promise<void> {
  const state = o.state ?? "failed";
  const batchId = o.batchId ?? (await seedBatch(admin));
  await admin.query(
    `INSERT INTO public.ai_batch_items
       (batch_id, photo_id, baby_id, attempt, prompt_version, schema_version, state, failure_kind, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - $10::interval)`,
    [
      batchId,
      o.photoId,
      o.babyId,
      o.attempt ?? 1,
      o.prompt ?? "v1",
      o.schema ?? "v1",
      state,
      o.failure === undefined ? (state === "failed" ? "invalid_output" : null) : o.failure,
      o.cost ?? null,
      o.ago ?? "0 seconds",
    ],
  );
}
