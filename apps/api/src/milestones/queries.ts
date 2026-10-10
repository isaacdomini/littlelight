import type { Milestone, MilestoneCategory } from "@tinyglow/shared";
import type { Tx } from "../auth";
import {
  PHOTO_SUMMARY_COLUMNS,
  PHOTO_THUMB_JOIN,
  type PhotoSummaryRow,
  SORT_EXPR,
  toPhotoSummary,
} from "../photos/queries";
import type { UrlSigner } from "../storage/sign";

// Milestone reads and the reindex fan-out for `/babies/:id/milestones` and `/milestones/:id`
// (docs/plans/step-5.md 2.4; PRD FR-3.2, FR-8.2). Everything runs under the caller's claims:
// presets (`baby_id IS NULL`) are readable by every member, custom milestones by members of their
// baby; writes are the RLS policies' business (custom only, admins only). Names are user text:
// never logged or audited.

/** At most this many photos are re-indexed directly after a rename/delete (plan 2.4). */
export const MILESTONE_REINDEX_MAX = 500;

export interface MilestoneRow {
  id: string;
  baby_id: string | null;
  name: string;
  category: MilestoneCategory;
  sort_order: number;
  created_at: Date;
  photo_count: number;
  cover_photo_id: string | null;
}

/** Live approved album photos of `p.baby_id = $1` tagged with milestone `m`. */
const TAGGED_PHOTOS = `
  FROM public.photo_details pd
  JOIN public.photos p ON p.id = pd.photo_id
 WHERE pd.milestone_id = m.id AND p.baby_id = $1
   AND p.approval = 'approved' AND p.deleted_at IS NULL
   AND p.status NOT IN ('failed', 'duplicate')`;

/**
 * Presets plus the baby's custom milestones (or the one `milestoneId`), each with the count of
 * live approved photos and the earliest of them as the cover. Presets by `sort_order`, then
 * custom ones by `created_at`.
 */
export async function milestoneRows(
  client: Tx,
  babyId: string,
  milestoneId?: string,
): Promise<MilestoneRow[]> {
  const values: unknown[] = [babyId];
  let only = "";
  if (milestoneId) {
    values.push(milestoneId);
    only = "AND m.id = $2";
  }
  const { rows } = await client.query<MilestoneRow>(
    `SELECT m.id, m.baby_id, m.name, m.category, m.sort_order, m.created_at,
            (SELECT count(*)::int ${TAGGED_PHOTOS}) AS photo_count,
            (SELECT p.id ${TAGGED_PHOTOS}
              ORDER BY ${SORT_EXPR}, p.id LIMIT 1) AS cover_photo_id
       FROM public.milestones m
      WHERE (m.baby_id IS NULL OR m.baby_id = $1) ${only}
      ORDER BY (m.baby_id IS NOT NULL),
               CASE WHEN m.baby_id IS NULL THEN m.sort_order END,
               m.created_at, m.id`,
    values,
  );
  return rows;
}

/** Summary rows (with `sort_key`-free columns) of cover photos, by id. */
export async function coverPhotoRows(
  client: Tx,
  ids: readonly string[],
): Promise<Map<string, PhotoSummaryRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<PhotoSummaryRow>(
    `SELECT ${PHOTO_SUMMARY_COLUMNS}
       FROM public.photos p ${PHOTO_THUMB_JOIN}
      WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Load milestones and their covers in one claims transaction (signing happens later). */
export async function loadMilestones(
  client: Tx,
  babyId: string,
  milestoneId?: string,
): Promise<{ rows: MilestoneRow[]; covers: Map<string, PhotoSummaryRow> }> {
  const rows = await milestoneRows(client, babyId, milestoneId);
  const ids = [...new Set(rows.map((r) => r.cover_photo_id).filter((x): x is string => !!x))];
  return { rows, covers: await coverPhotoRows(client, ids) };
}

/** Row (+ its cover) → `milestoneSchema`, signing the cover thumb. */
export async function toMilestone(
  signer: UrlSigner,
  r: MilestoneRow,
  covers: ReadonlyMap<string, PhotoSummaryRow>,
): Promise<Milestone> {
  const cover = r.cover_photo_id ? covers.get(r.cover_photo_id) : undefined;
  const coverPhoto = cover ? await toPhotoSummary(signer, cover) : null;
  const first = cover ? (cover.taken_at ?? cover.created_at) : null;
  return {
    id: r.id,
    babyId: r.baby_id,
    name: r.name,
    category: r.category,
    isPreset: r.baby_id === null,
    sortOrder: r.sort_order,
    photoCount: r.photo_count,
    firstTakenAt: first?.toISOString() ?? null,
    coverPhoto,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Live photos tagged with a milestone (any approval: their search documents name it), up to
 * `MILESTONE_REINDEX_MAX + 1` so the caller can tell when it is over the cap.
 */
export async function taggedPhotoIds(
  client: Tx,
  milestoneId: string,
): Promise<Array<{ photo_id: string; baby_id: string }>> {
  const { rows } = await client.query<{ photo_id: string; baby_id: string }>(
    `SELECT pd.photo_id, p.baby_id
       FROM public.photo_details pd
       JOIN public.photos p ON p.id = pd.photo_id
      WHERE pd.milestone_id = $1 AND p.deleted_at IS NULL
      ORDER BY pd.photo_id
      LIMIT $2`,
    [milestoneId, MILESTONE_REINDEX_MAX + 1],
  );
  return rows;
}
