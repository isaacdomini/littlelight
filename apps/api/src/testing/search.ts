import { fakeEmbedding } from "@littlelight/ai";
import type pg from "pg";

// Superuser fixtures for the search and chat integration tests (apps/api). Test-only.

export interface SearchRowInput {
  photoId: string;
  babyId: string;
  text: string;
  tags?: string[];
  people?: string[];
  place?: string | null;
  takenAt?: string;
  ageDays?: number | null;
  milestoneIds?: string[];
  /** Default true: a 1024-dim fake embedding of `text`. */
  vector?: boolean;
}

/** `[0.1,0.2,…]` text input of pgvector. */
function vectorText(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** One `photo_search` row (the guard applies: approved live photo of a paid baby). */
export async function seedSearchRow(admin: pg.Client, o: SearchRowInput): Promise<void> {
  const vec = o.vector === false ? null : vectorText(fakeEmbedding(o.text, 1024));
  await admin.query(
    `INSERT INTO public.photo_search
       (photo_id, baby_id, search_text, tags, people, place, taken_at, age_days, milestone_ids,
        content_hash, embed_model, doc_version, embedding, embedded_at)
     VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7::timestamptz, $8, $9::uuid[],
             'test-hash', $10, 'v1', $11::vector, $12)`,
    [
      o.photoId,
      o.babyId,
      o.text,
      o.tags ?? [],
      o.people ?? [],
      o.place === undefined ? null : o.place,
      o.takenAt ?? "2026-06-10T12:00:00Z",
      o.ageDays === undefined ? 101 : o.ageDays,
      o.milestoneIds ?? [],
      vec ? "fake/1024" : null,
      vec,
      vec ? new Date() : null,
    ],
  );
}

export async function seedDetails(
  admin: pg.Client,
  photoId: string,
  o: {
    note?: string | null;
    people?: string[];
    milestoneId?: string | null;
    location?: string | null;
    editedBy: string;
  },
): Promise<void> {
  await admin.query(
    `INSERT INTO public.photo_details (photo_id, note, people, milestone_id, location_label, edited_by)
     VALUES ($1, $2, $3::text[], $4, $5, $6)`,
    [
      photoId,
      o.note ?? null,
      o.people ?? [],
      o.milestoneId ?? null,
      o.location ?? null,
      o.editedBy,
    ],
  );
}

export async function seedMeasurement(
  admin: pg.Client,
  o: {
    babyId: string;
    photoId?: string | null;
    kind?: "weight" | "height" | "head";
    valueMetric?: number;
    measuredAt?: string;
    createdBy: string;
  },
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO public.measurements (baby_id, photo_id, kind, value_metric, value_entered, unit_entered, measured_at, created_by)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7) RETURNING id`,
    [
      o.babyId,
      o.photoId ?? null,
      o.kind ?? "weight",
      o.valueMetric ?? 7200,
      (o.kind ?? "weight") === "weight" ? "g" : "mm",
      o.measuredAt ?? "2026-09-01T09:00:00Z",
      o.createdBy,
    ],
  );
  return (rows[0] as { id: string }).id;
}
