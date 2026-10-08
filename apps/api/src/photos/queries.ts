import {
  type BabyRole,
  type DerivativeKind,
  derivativeKey,
  type PhotoApproval,
  type PhotoDetails,
  type PhotoExif,
  type PhotoMime,
  type PhotoStatus,
  type PhotoSummary,
  type PhotosView,
} from "@littlelight/shared";
import type { Tx } from "../auth";
import { ApiError } from "../lib/errors";
import type { UrlSigner } from "../storage/sign";

// Photo reads shared by `/babies/:id/photos`, `/photos/:id…` and the upload session view
// (docs/plans/step-4.md 2.4, 2.10). All of them run inside `withClaims`, so Postgres RLS decides
// visibility: admins see everything of their babies (trash and the approval queue included),
// contributors the approved live album plus their own uploads; quarantined rows exist for nobody.
// Every query names its columns (column grants). Signing happens after the transaction, from
// keys rebuilt with `derivativeKey(babyId, photoId, 'thumb' | 'display')`: never a key read from
// a row, so an `analysis` derivative or an original can never be signed through this path.

/** Columns of `photoSummarySchema` plus whether a thumb exists (alias `p`, join alias `t`). */
export const PHOTO_SUMMARY_COLUMNS = `
  p.id, p.baby_id, p.status, p.approval, p.taken_at, p.taken_at_estimated, p.age_days,
  p.width, p.height, p.mime, p.is_sensitive, p.duplicate_of_photo_id, p.uploaded_by,
  p.created_at, p.deleted_at, (t.photo_id IS NOT NULL) AS has_thumb`;

/** The thumb derivative row, if the worker has written it. */
export const PHOTO_THUMB_JOIN = `
  LEFT JOIN public.photo_derivatives t ON t.photo_id = p.id AND t.kind = 'thumb'`;

export interface PhotoSummaryRow {
  id: string;
  baby_id: string;
  status: PhotoStatus;
  approval: PhotoApproval;
  taken_at: Date | null;
  taken_at_estimated: boolean;
  age_days: number | null;
  width: number | null;
  height: number | null;
  mime: PhotoMime | null;
  is_sensitive: boolean;
  duplicate_of_photo_id: string | null;
  uploaded_by: string | null;
  created_at: Date;
  deleted_at: Date | null;
  has_thumb: boolean;
}

/** User-facing derivative kinds. `analysis` is deliberately not assignable here. */
export type ServedDerivative = Extract<DerivativeKind, "thumb" | "display">;

/** Sign one served derivative of one photo. */
export function signDerivative(
  signer: UrlSigner,
  babyId: string,
  photoId: string,
  kind: ServedDerivative,
) {
  if (kind !== "thumb" && kind !== "display") throw new Error("only thumb/display are served");
  return signer.signGet(derivativeKey(babyId, photoId, kind));
}

/** Row → `photoSummary`, with a fresh signed `thumbUrl` when the thumb exists. */
export async function toPhotoSummary(signer: UrlSigner, r: PhotoSummaryRow): Promise<PhotoSummary> {
  const thumb = r.has_thumb ? await signDerivative(signer, r.baby_id, r.id, "thumb") : null;
  return {
    id: r.id,
    babyId: r.baby_id,
    status: r.status,
    approval: r.approval,
    takenAt: r.taken_at?.toISOString() ?? null,
    takenAtEstimated: r.taken_at_estimated,
    ageDays: r.age_days,
    width: r.width,
    height: r.height,
    mime: r.mime,
    isSensitive: r.is_sensitive,
    duplicateOfPhotoId: r.duplicate_of_photo_id,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at.toISOString(),
    deletedAt: r.deleted_at?.toISOString() ?? null,
    thumbUrl: thumb?.url ?? null,
    urlExpiresAt: thumb?.expiresAt.toISOString() ?? null,
  };
}

// ---- keyset cursor ------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Microsecond UTC timestamps as produced by `SORT_KEY_SQL` (Postgres precision, not JS ms). */
const SORT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** `COALESCE(taken_at, created_at)` as UTC text with microseconds, so the cursor is exact. */
const SORT_KEY_SQL = `to_char(COALESCE(p.taken_at, p.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface PhotoCursor {
  sortKey: string;
  id: string;
}

/** base64url(`<sortKey>|<id>`). Exported for tests. */
export function encodeCursor(c: PhotoCursor): string {
  return Buffer.from(`${c.sortKey}|${c.id}`, "utf8").toString("base64url");
}

/** Inverse of `encodeCursor`; 400 `validation_failed` (field path only) for anything else. */
export function decodeCursor(cursor: string): PhotoCursor {
  const invalid = () =>
    new ApiError(400, "validation_failed", "The request is invalid", {
      fields: ["querystring.cursor"],
    });
  let text: string;
  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw invalid();
  }
  const [sortKey, id, extra] = text.split("|");
  if (extra !== undefined || !sortKey || !id) throw invalid();
  if (!SORT_KEY_RE.test(sortKey) || Number.isNaN(Date.parse(sortKey)) || !UUID_RE.test(id)) {
    throw invalid();
  }
  return { sortKey, id: id.toLowerCase() };
}

// ---- queries --------------------------------------------------------------------------------------

/** The caller's membership of a baby (RLS: members see their babies' member rows). */
export interface BabyAccess {
  role: BabyRole;
  plan: "free" | "plus";
  birthDate: string;
  deletedAt: Date | null;
}

/** null when the caller is not a member, or the baby is trashed and the caller is not an admin. */
export async function babyAccess(
  client: Tx,
  uid: string,
  babyId: string,
): Promise<BabyAccess | null> {
  const { rows } = await client.query<{
    role: BabyRole;
    plan: "free" | "plus";
    birth_date: string;
    deleted_at: Date | null;
  }>(
    `SELECT m.role, b.plan, to_char(b.birth_date, 'YYYY-MM-DD') AS birth_date, b.deleted_at
       FROM public.babies b
       JOIN public.baby_members m ON m.baby_id = b.id AND m.user_id = $1
      WHERE b.id = $2`,
    [uid, babyId],
  );
  const r = rows[0];
  return r
    ? { role: r.role, plan: r.plan, birthDate: r.birth_date, deletedAt: r.deleted_at }
    : null;
}

/**
 * Photos of a baby that count toward the free-tier cap, from the DB's single definition
 * `free_tier_photo_count` (SECURITY DEFINER: not trashed, not quarantined, status not
 * failed/duplicate; pending counts). Exact for any member, admin or contributor; 0 for a
 * non-member. Runs under the caller's claims; the `photos_free_tier_cap` trigger is the hard stop.
 */
export async function countLivePhotos(client: Tx, babyId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "SELECT public.free_tier_photo_count($1) AS n",
    [babyId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Album and approval queue never list failed ingests or duplicate markers: failed uploads
 * surface only through their upload session. The admin trash may still show a trashed failed
 * photo (so it can be found and purged).
 */
const VIEW_FILTER: Readonly<Record<PhotosView, string>> = Object.freeze({
  album:
    "p.deleted_at IS NULL AND p.approval <> 'rejected' AND p.status NOT IN ('failed', 'duplicate')",
  pending:
    "p.deleted_at IS NULL AND p.approval = 'pending' AND p.status NOT IN ('failed', 'duplicate')",
  trash: "p.deleted_at IS NOT NULL AND p.status <> 'duplicate'",
});

/**
 * False when a photo row (from `photoWithRole`) must look nonexistent to the caller: RLS hid it,
 * or the caller is not an admin and it is trashed (D12) or a failed ingest.
 */
export function visibleToCaller<
  T extends { role: BabyRole | null; deleted_at: Date | null; status: PhotoStatus },
>(p: T | null): p is T {
  if (!p) return false;
  if (p.role === "admin") return true;
  return p.deleted_at === null && p.status !== "failed";
}

export interface ListPhotosInput {
  babyId: string;
  view: PhotosView;
  cursor: PhotoCursor | null;
  limit: number;
}

/** One page, newest first (`COALESCE(taken_at, created_at) DESC, id DESC`), plus the next cursor. */
export async function listPhotoRows(
  client: Tx,
  input: ListPhotosInput,
): Promise<{ rows: PhotoSummaryRow[]; next: PhotoCursor | null }> {
  const filter = VIEW_FILTER[input.view];
  const values: unknown[] = [input.babyId];
  let keyset = "";
  if (input.cursor) {
    values.push(input.cursor.sortKey, input.cursor.id);
    keyset = "AND (COALESCE(p.taken_at, p.created_at), p.id) < ($2::timestamptz, $3::uuid)";
  }
  values.push(input.limit + 1);
  const { rows } = await client.query<PhotoSummaryRow & { sort_key: string }>(
    `SELECT ${PHOTO_SUMMARY_COLUMNS}, ${SORT_KEY_SQL} AS sort_key
       FROM public.photos p ${PHOTO_THUMB_JOIN}
      WHERE p.baby_id = $1 AND ${filter} ${keyset}
      ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
      LIMIT $${values.length}`,
    values,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const next = rows.length > input.limit && last ? { sortKey: last.sort_key, id: last.id } : null;
  return { rows: page, next };
}

/** Pending, live photos visible to the caller (admins: all; contributors: their own). */
export async function countPending(client: Tx, babyId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.photos
      WHERE baby_id = $1 AND approval = 'pending' AND deleted_at IS NULL
        AND status NOT IN ('failed', 'duplicate')`,
    [babyId],
  );
  return rows[0]?.n ?? 0;
}

/** Photo summaries by id (RLS-filtered; missing ids are simply absent). */
export async function photoRowsByIds(
  client: Tx,
  ids: readonly string[],
): Promise<PhotoSummaryRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<PhotoSummaryRow>(
    `SELECT ${PHOTO_SUMMARY_COLUMNS}
       FROM public.photos p ${PHOTO_THUMB_JOIN}
      WHERE p.id = ANY($1::uuid[]) AND p.status <> 'duplicate'`,
    [ids],
  );
  return rows;
}

/** One photo with the caller's role on its baby, or null when RLS hides it. */
export async function photoWithRole(
  client: Tx,
  uid: string,
  photoId: string,
): Promise<
  | (PhotoSummaryRow & {
      role: BabyRole | null;
      has_display: boolean;
      storage_key_original: string;
    })
  | null
> {
  const { rows } = await client.query<
    PhotoSummaryRow & { role: BabyRole | null; has_display: boolean; storage_key_original: string }
  >(
    `SELECT ${PHOTO_SUMMARY_COLUMNS}, m.role, p.storage_key_original,
            EXISTS (SELECT 1 FROM public.photo_derivatives d
                     WHERE d.photo_id = p.id AND d.kind = 'display') AS has_display
       FROM public.photos p ${PHOTO_THUMB_JOIN}
       LEFT JOIN public.baby_members m ON m.baby_id = p.baby_id AND m.user_id = $1
      WHERE p.id = $2 AND p.status <> 'duplicate'`,
    [uid, photoId],
  );
  return rows[0] ?? null;
}

/** The authenticated-visible `photo_exif` columns: never GPS ciphertext, never `raw_json`. */
export async function photoExif(client: Tx, photoId: string): Promise<PhotoExif | null> {
  const { rows } = await client.query<{
    taken_at: Date | null;
    tz_offset_minutes: number | null;
    camera_make: string | null;
    camera_model: string | null;
    place_label: string | null;
  }>(
    `SELECT taken_at, tz_offset_minutes, camera_make, camera_model, place_label
       FROM public.photo_exif WHERE photo_id = $1`,
    [photoId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    takenAt: r.taken_at?.toISOString() ?? null,
    tzOffsetMinutes: r.tz_offset_minutes,
    cameraMake: r.camera_make,
    cameraModel: r.camera_model,
    placeLabel: r.place_label,
  };
}

export async function photoDetails(client: Tx, photoId: string): Promise<PhotoDetails | null> {
  const { rows } = await client.query<{
    milestone_id: string | null;
    note: string | null;
    people: string[];
    location_label: string | null;
  }>(
    `SELECT milestone_id, note, people, location_label
       FROM public.photo_details WHERE photo_id = $1`,
    [photoId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    milestoneId: r.milestone_id,
    note: r.note,
    people: r.people ?? [],
    locationLabel: r.location_label,
  };
}
