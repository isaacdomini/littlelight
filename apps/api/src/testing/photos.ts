import { randomUUID } from "node:crypto";
import type pg from "pg";

// Superuser fixtures for photo tests (apps/api integration). Test-only.

export interface SeedPhoto {
  id?: string;
  status?: string;
  approval?: "pending" | "approved" | "rejected";
  uploadedBy?: string | null;
  /** SQL interval string, e.g. "1 hour"; sets deleted_at = now() - interval. */
  trashedAgo?: string;
  /** lowercase hex SHA-256 */
  sha256?: string;
  takenAt?: string;
  withThumb?: boolean;
  withDisplay?: boolean;
  /** Also writes an `analysis` derivative row. */
  withAnalysis?: boolean;
  mime?: string;
  quarantined?: boolean;
}

/** Insert one photo (and optional derivative rows); returns its id. */
export async function seedPhoto(
  admin: pg.Client,
  babyId: string,
  o: SeedPhoto = {},
): Promise<string> {
  const id = o.id ?? randomUUID();
  const approval = o.approval ?? "approved";
  await admin.query(
    `INSERT INTO public.photos
       (id, baby_id, uploaded_by, storage_key_original, status, approval, sha256, taken_at,
        mime, deleted_at, quarantined_at)
     VALUES ($1, $2, $3, $4, $5, $6, decode($7::text, 'hex'), $8, $9,
             ${o.trashedAgo ? `now() - interval '${o.trashedAgo}'` : "NULL"},
             ${o.quarantined ? "now()" : "NULL"})`,
    [
      id,
      babyId,
      o.uploadedBy ?? null,
      `babies/${babyId}/originals/${id}`,
      o.status ?? "ready",
      approval,
      o.sha256 ?? null,
      o.takenAt ?? "2026-06-14T10:00:00Z",
      o.mime ?? "image/jpeg",
    ],
  );
  const kinds = [
    ...(o.withThumb ? ["thumb"] : []),
    ...(o.withDisplay ? ["display"] : []),
    ...(o.withAnalysis ? ["analysis"] : []),
  ];
  for (const kind of kinds) {
    await admin.query(
      `INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
       VALUES ($1, $2, $3, 10, 10, 10)`,
      [id, kind, `babies/${babyId}/derivatives/${id}/${kind}.jpg`],
    );
  }
  return id;
}

/** Bulk-insert `n` counted (ingested, approved, live) photos with unique keys; fast. */
export async function seedManyPhotos(admin: pg.Client, babyId: string, n: number): Promise<void> {
  await admin.query(
    `INSERT INTO public.photos (baby_id, storage_key_original, status, approval)
     SELECT $1::uuid, 'bulk/' || $1::text || '/' || g, 'ingested', 'approved' FROM generate_series(1, $2::int) g`,
    [babyId, n],
  );
}
