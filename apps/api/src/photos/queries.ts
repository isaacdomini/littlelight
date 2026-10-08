import {
  ageGroupSortValue,
  type BabyRole,
  type DerivativeKind,
  derivativeKey,
  PHOTO_DETAILS_LIMITS,
  type PhotoApproval,
  type PhotoDetails,
  type PhotoDetailsPatch,
  type PhotoExif,
  type PhotoGroup,
  type PhotoMime,
  type PhotoStatus,
  type PhotoSummary,
  type PhotosBatchDetailsRequest,
  type PhotosListDir,
  type PhotosView,
  type PhotoUrlSet,
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
//
// Step 5 (docs/plans/step-5.md 2.4, 2.4a): every summary also carries `photo_details.milestone_id`
// and the override-aware caption (`photo_ai_overrides` field `caption`, else
// `photo_ai.description.caption`), both read under the caller's claims (`photo_visible`). They
// are correlated subqueries evaluated only for returned rows, so the timeline's keyset scan on
// `photos_baby_id_sort_idx` is unaffected. This is a read path only: no model, no AI write.

/**
 * `milestone_id` and `caption` of photo `p` (correlated subqueries). Usable in a SELECT list and
 * in `UPDATE … RETURNING`. Non-string JSON in an override or AI caption reads as NULL.
 */
export const PHOTO_SUMMARY_EXTRA_COLUMNS = `
  (SELECT pd.milestone_id FROM public.photo_details pd WHERE pd.photo_id = p.id) AS milestone_id,
  COALESCE(
    (SELECT CASE WHEN jsonb_typeof(ov.value) = 'string' THEN ov.value #>> '{}' END
       FROM public.photo_ai_overrides ov
      WHERE ov.photo_id = p.id AND ov.field_path = 'caption'),
    (SELECT CASE WHEN jsonb_typeof(ai.description -> 'caption') = 'string'
                 THEN ai.description ->> 'caption' END
       FROM public.photo_ai ai WHERE ai.photo_id = p.id)
  ) AS caption`;

/** Columns of `photoSummarySchema` plus whether a thumb exists (alias `p`, join alias `t`). */
export const PHOTO_SUMMARY_COLUMNS = `
  p.id, p.baby_id, p.status, p.approval, p.taken_at, p.taken_at_estimated, p.age_days,
  p.width, p.height, p.mime, p.is_sensitive, p.duplicate_of_photo_id, p.uploaded_by,
  p.created_at, p.deleted_at, (t.photo_id IS NOT NULL) AS has_thumb,
  ${PHOTO_SUMMARY_EXTRA_COLUMNS}`;

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
  /** `photo_details.milestone_id` (absent from rows read without `PHOTO_SUMMARY_EXTRA_COLUMNS`). */
  milestone_id?: string | null;
  /** Override-aware caption (2.4a). */
  caption?: string | null;
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
    milestoneId: r.milestone_id ?? null,
    caption: r.caption ?? null,
  };
}

// ---- keyset cursor ------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Microsecond UTC timestamps as produced by `SORT_KEY_SQL` (Postgres precision, not JS ms). */
const SORT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * The timeline sort key of photo `p`: the stored generated column `photos.sort_at` (=
 * `COALESCE(taken_at, created_at)`, NOT NULL), indexed by `photos_baby_id_sort_idx (baby_id,
 * sort_at DESC, id DESC) WHERE deleted_at IS NULL`. A plain column on purpose: under RLS Postgres
 * only turns leakproof user quals into index conditions, and a COALESCE expression counts as
 * leaky, so with the expression the keyset bound became a post-RLS filter and page N cost
 * N x limit rows. With the column, ORDER BY and `(p.sort_at, p.id) < ($2, $3)` are both served
 * by the index for every page.
 */
export const SORT_EXPR = "p.sort_at";

/** `SORT_EXPR` as UTC text with microseconds, so the cursor is exact. */
const SORT_KEY_SQL = `to_char(${SORT_EXPR} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

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
  /** `older` (default): items after `cursor` in timeline order; `newer`: the items just before it. */
  dir?: PhotosListDir;
  /** Keep only photos whose `photo_details.milestone_id` is this milestone. */
  milestoneId?: string | null;
}

/**
 * The page query. The ORDER BY and the keyset predicate are textually the expression of
 * `photos_baby_id_sort_idx` (`COALESCE(taken_at, created_at)`, then `id`), so every page is an
 * index range scan (packages/db/README.md "Timeline and details"). `dir=newer` walks the index
 * backwards (ascending) from the cursor; `listPhotoRows` reverses those rows. Without a cursor
 * `dir` is ignored (the first page is always the newest). Exported for tests.
 */
export function listPhotosSql(input: ListPhotosInput): { text: string; values: unknown[] } {
  const filter = VIEW_FILTER[input.view];
  const newer = input.dir === "newer" && input.cursor !== null;
  const values: unknown[] = [input.babyId];
  let milestone = "";
  if (input.milestoneId) {
    values.push(input.milestoneId);
    milestone = `AND EXISTS (SELECT 1 FROM public.photo_details f
                              WHERE f.photo_id = p.id AND f.milestone_id = $${values.length}::uuid)`;
  }
  let keyset = "";
  if (input.cursor) {
    values.push(input.cursor.sortKey, input.cursor.id);
    const ts = `$${values.length - 1}::timestamptz`;
    const id = `$${values.length}::uuid`;
    keyset = `AND (${SORT_EXPR}, p.id) ${newer ? ">" : "<"} (${ts}, ${id})`;
  }
  values.push(input.limit + 1);
  const order = newer ? `${SORT_EXPR} ASC, p.id ASC` : `${SORT_EXPR} DESC, p.id DESC`;
  const text = `SELECT ${PHOTO_SUMMARY_COLUMNS}, ${SORT_KEY_SQL} AS sort_key
       FROM public.photos p ${PHOTO_THUMB_JOIN}
      WHERE p.baby_id = $1 AND ${filter} ${milestone} ${keyset}
      ORDER BY ${order}
      LIMIT $${values.length}`;
  return { text, values };
}

export interface PhotoPage {
  /** Newest first, whatever the direction. */
  rows: PhotoSummaryRow[];
  /** Cursor of the newest item of the page (null when empty). */
  first: PhotoCursor | null;
  /** Cursor of the oldest item of the page (null when empty). */
  last: PhotoCursor | null;
  /** More rows exist beyond the page in the requested direction. */
  more: boolean;
}

/**
 * One page of `limit` rows in the requested direction, returned newest first
 * (`COALESCE(taken_at, created_at) DESC, id DESC`), plus the edge cursors.
 */
export async function listPhotoRows(client: Tx, input: ListPhotosInput): Promise<PhotoPage> {
  const { text, values } = listPhotosSql(input);
  const { rows } = await client.query<PhotoSummaryRow & { sort_key: string }>(text, values);
  return toPhotoPage(rows, input.limit, input.dir === "newer" && input.cursor !== null);
}

/** Trim the look-ahead row and restore newest-first order for `dir=newer`. Exported for tests. */
export function toPhotoPage(
  rows: readonly (PhotoSummaryRow & { sort_key: string })[],
  limit: number,
  ascending: boolean,
): PhotoPage {
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (ascending) page.reverse();
  const cursorOf = (r: (typeof page)[number] | undefined) =>
    r ? { sortKey: r.sort_key, id: r.id } : null;
  const out = page.map(({ sort_key: _sortKey, ...row }) => row);
  return { rows: out, first: cursorOf(page[0]), last: cursorOf(page[page.length - 1]), more };
}

/**
 * `nextCursor` / `prevCursor` of a page (step-5 plan 2.4). `dir=older`: next = the last item
 * when more exist, prev = the first item (the client fetches newer pages only after a jump).
 * `dir=newer`: prev = the first item when more newer ones exist, next = the last item. Exported
 * for tests.
 */
export function pageCursors(
  page: Pick<PhotoPage, "first" | "last" | "more">,
  dir: PhotosListDir,
  hadCursor: boolean,
): { nextCursor: string | null; prevCursor: string | null } {
  const enc = (c: PhotoCursor | null) => (c ? encodeCursor(c) : null);
  if (dir === "newer" && hadCursor) {
    return { nextCursor: enc(page.last), prevCursor: page.more ? enc(page.first) : null };
  }
  return { nextCursor: page.more ? enc(page.last) : null, prevCursor: enc(page.first) };
}

// ---- timeline summary -----------------------------------------------------------------------------

/** Larger than every v4 uuid: a group cursor `(top, MAX_UUID)` starts at the group's newest item. */
export const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export interface GroupCountRow {
  key: string;
  n: number;
  /** Newest `COALESCE(taken_at, created_at)` in the group, as `SORT_KEY_SQL` text. */
  top: string;
}

/**
 * Per-age-group counts of the view, one query over `photos_baby_id_age_days_idx` (the
 * `age_group` function is the SQL twin of `ageGroupKey`).
 */
export async function groupCounts(
  client: Tx,
  babyId: string,
  view: PhotosView,
): Promise<GroupCountRow[]> {
  const { rows } = await client.query<GroupCountRow>(
    `SELECT public.age_group(p.age_days) AS key, count(*)::int AS n,
            to_char(max(${SORT_EXPR}) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS top
       FROM public.photos p
      WHERE p.baby_id = $1 AND ${VIEW_FILTER[view]}
      GROUP BY 1`,
    [babyId],
  );
  return rows;
}

function safeSortValue(key: string): number {
  try {
    return ageGroupSortValue(key);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/**
 * Groups newest first (descending `ageGroupSortValue`), each with a jump cursor
 * `encodeCursor({sortKey: top, id: MAX_UUID})` so `GET …/photos?cursor=` starts exactly at the
 * group's newest item. Exported for tests.
 */
export function toPhotoGroups(rows: readonly GroupCountRow[]): {
  total: number;
  groups: PhotoGroup[];
} {
  const groups = [...rows]
    .sort((a, b) => safeSortValue(b.key) - safeSortValue(a.key) || a.key.localeCompare(b.key))
    .map((r) => ({
      key: r.key,
      count: r.n,
      cursor: encodeCursor({ sortKey: r.top, id: MAX_UUID }),
    }));
  return { total: rows.reduce((sum, r) => sum + r.n, 0), groups };
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

/** Whether the caller may edit details / delete (the DB's `photo_editable`, the RLS rule itself). */
export async function photoEditable(client: Tx, photoId: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>("SELECT public.photo_editable($1) AS ok", [
    photoId,
  ]);
  return rows[0]?.ok === true;
}

// ---- batch URL refresh ---------------------------------------------------------------------------

export interface PhotoUrlRow {
  id: string;
  baby_id: string;
  status: PhotoStatus;
  deleted_at: Date | null;
  has_thumb: boolean;
  has_display: boolean;
}

/** Derivative presence of photos of one baby (RLS-filtered; unknown ids are absent). */
export async function photoUrlRows(
  client: Tx,
  babyId: string,
  ids: readonly string[],
): Promise<PhotoUrlRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<PhotoUrlRow>(
    `SELECT p.id, p.baby_id, p.status, p.deleted_at,
            EXISTS (SELECT 1 FROM public.photo_derivatives x
                     WHERE x.photo_id = p.id AND x.kind = 'thumb') AS has_thumb,
            EXISTS (SELECT 1 FROM public.photo_derivatives x
                     WHERE x.photo_id = p.id AND x.kind = 'display') AS has_display
       FROM public.photos p
      WHERE p.id = ANY($1::uuid[]) AND p.baby_id = $2 AND p.status <> 'duplicate'`,
    [ids, babyId],
  );
  return rows;
}

/** Fresh thumb/display URLs of one photo; `urlExpiresAt` is the earlier expiry. */
export async function signPhotoUrls(
  signer: UrlSigner,
  r: Pick<PhotoUrlRow, "id" | "baby_id" | "has_thumb" | "has_display">,
): Promise<PhotoUrlSet> {
  const [thumb, display] = await Promise.all([
    r.has_thumb ? signDerivative(signer, r.baby_id, r.id, "thumb") : null,
    r.has_display ? signDerivative(signer, r.baby_id, r.id, "display") : null,
  ]);
  const expiries = [thumb?.expiresAt, display?.expiresAt].filter((d): d is Date => !!d);
  const earliest = expiries.length ? new Date(Math.min(...expiries.map((d) => d.getTime()))) : null;
  return {
    thumbUrl: thumb?.url ?? null,
    displayUrl: display?.url ?? null,
    urlExpiresAt: earliest?.toISOString() ?? null,
  };
}

// ---- parent details (FR-3) ---------------------------------------------------------------------

/**
 * Milestone a photo of `babyId` may be tagged with: a preset, or a custom milestone of that baby
 * (read under the caller's claims). There is no DB rule for the cross-baby case, so the API
 * checks it here: 409 when the milestone is not visible (deleted, or someone else's) or belongs
 * to another album.
 */
export async function assertMilestoneUsable(
  client: Tx,
  milestoneId: string,
  babyId: string,
): Promise<void> {
  const { rows } = await client.query<{ baby_id: string | null }>(
    "SELECT m.baby_id FROM public.milestones m WHERE m.id = $1",
    [milestoneId],
  );
  const m = rows[0];
  if (!m) throw new ApiError(409, "conflict", "That milestone doesn't exist anymore");
  if (m.baby_id !== null && m.baby_id !== babyId) {
    throw new ApiError(409, "conflict", "That milestone belongs to another album");
  }
}

/**
 * People chips as stored: trimmed (zod already trims), empty ones dropped, de-duplicated
 * case-insensitively keeping the first spelling and order. Exported for tests.
 */
export function normalizePeople(people: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of people) {
    const name = raw.trim().slice(0, PHOTO_DETAILS_LIMITS.personName);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** An empty note / label is stored as NULL. */
const blankToNull = (v: string | null): string | null => (v === null || v.trim() === "" ? null : v);

/** Provided details fields → `photo_details` column values (undefined keys are untouched). */
function detailColumns(
  patch: Pick<PhotoDetailsPatch, "milestoneId" | "note" | "locationLabel">,
): Array<readonly [column: string, value: unknown, cast: string]> {
  const cols: Array<readonly [string, unknown, string]> = [];
  if (patch.milestoneId !== undefined) cols.push(["milestone_id", patch.milestoneId, "uuid"]);
  if (patch.note !== undefined) cols.push(["note", blankToNull(patch.note), "text"]);
  if (patch.locationLabel !== undefined) {
    cols.push(["location_label", blankToNull(patch.locationLabel), "text"]);
  }
  return cols;
}

/**
 * `PATCH /photos/:id/details`: upsert under the caller's claims, setting only the provided
 * fields (`people` replaces the array; `null` clears a scalar). Column names come from a fixed
 * list; every value is a bind parameter. Exported for tests.
 */
export function detailsUpsertSql(
  photoId: string,
  uid: string,
  patch: PhotoDetailsPatch,
): { text: string; values: unknown[] } {
  const cols = detailColumns(patch);
  if (patch.people !== undefined) cols.push(["people", normalizePeople(patch.people), "text[]"]);
  const values: unknown[] = [photoId, uid];
  const names = ["photo_id", "edited_by"];
  const params = ["$1::uuid", "$2::uuid"];
  for (const [column, value, cast] of cols) {
    values.push(value);
    names.push(column);
    params.push(`$${values.length}::${cast}`);
  }
  const sets = names.slice(1).map((c) => `${c} = EXCLUDED.${c}`);
  const text = `INSERT INTO public.photo_details AS pd (${names.join(", ")})
       VALUES (${params.join(", ")})
       ON CONFLICT (photo_id) DO UPDATE SET ${sets.join(", ")}
       RETURNING pd.photo_id`;
  return { text, values };
}

/**
 * `POST /babies/:id/photos/details` (FR-3.1): one statement for the whole batch. Targets are the
 * requested ids that are photos of `babyId`, visible (RLS) and editable by the caller
 * (`photo_editable`, the policies' own rule); `addPeople` is merged into each photo's people
 * (union, case-insensitive, first spelling and order kept) and a photo whose union would exceed
 * the cap is left out. Returns the written `photo_id`s; every other id is "skipped". Exported for
 * tests.
 */
export function batchDetailsSql(
  babyId: string,
  uid: string,
  ids: readonly string[],
  body: Pick<PhotosBatchDetailsRequest, "milestoneId" | "addPeople" | "note" | "locationLabel">,
): { text: string; values: unknown[] } {
  const add = normalizePeople(body.addPeople ?? []);
  const values: unknown[] = [ids, babyId, uid, add, PHOTO_DETAILS_LIMITS.people];
  const names = ["photo_id", "edited_by", "people"];
  const selects = ["m.id", "$3::uuid", "m.people"];
  const sets = ["edited_by = EXCLUDED.edited_by"];
  if (add.length > 0) sets.push("people = EXCLUDED.people");
  for (const [column, value, cast] of detailColumns(body)) {
    values.push(value);
    names.push(column);
    selects.push(`$${values.length}::${cast}`);
    sets.push(`${column} = EXCLUDED.${column}`);
  }
  const text = `WITH target AS (
         SELECT p.id
           FROM public.photos p
          WHERE p.id = ANY($1::uuid[]) AND p.baby_id = $2::uuid AND p.status <> 'duplicate'
            AND public.photo_editable(p.id)
       ), merged AS (
         SELECT t.id,
                ARRAY(SELECT (array_agg(u.x ORDER BY u.o))[1]
                        FROM unnest(COALESCE(pd.people, '{}'::text[]) || $4::text[])
                             WITH ORDINALITY AS u(x, o)
                       GROUP BY lower(u.x)
                       ORDER BY min(u.o)) AS people
           FROM target t
           LEFT JOIN public.photo_details pd ON pd.photo_id = t.id
       )
       INSERT INTO public.photo_details AS d (${names.join(", ")})
       SELECT ${selects.join(", ")} FROM merged m
        WHERE cardinality(m.people) <= $5::int
       ON CONFLICT (photo_id) DO UPDATE SET ${sets.join(", ")}
       RETURNING d.photo_id`;
  return { text, values };
}
