import type {
  BabyRole,
  ShareAlbum,
  SharedPhotoAddedBy,
  ShareLink,
  ShareLinkStatus,
  ShareRule,
  ShareRuleMode,
  ViewerMediaKind,
  ViewerPhoto,
} from "@littlelight/shared";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { z } from "zod";
import { ApiError, forbidden, internalError, notFound } from "../lib/errors";
import { babyAccess, type PhotoCursor } from "../photos/queries";
import type { SignedUrl, UrlSigner } from "../storage/sign";
import type { ViewerSession } from "./viewer-auth";

// SQL and row mappers of `apps/api/src/sharing` (docs/plans/step-8.md 2.5, 2.6).
//
// Admin side: every statement runs under the caller's own claims (`authenticated`); RLS
// (`is_baby_admin` on every sharing policy) is the backstop for the API's admin check, and no
// statement here reads a hash column (`token_hash` / `passcode_hash` are write-only for users).
// Viewer side: every statement runs as the `viewer` role after `viewer_session_check`, so RLS
// limits rows to the viewer's active link (`viewer_photo_ids()`) and derivative storage keys to
// photos that are not hidden (`viewer_media_photo_ids()`): a hidden sensitive photo's key cannot
// even be read, so it cannot be signed. Columns are always named (the viewer role has column
// grants only). Nothing here logs a token, URL, name or tag.

export type Tx = pg.PoolClient;

// ---- admin access ---------------------------------------------------------------------------------

export const shareBabyNotFound = () =>
  notFound("That album doesn't exist or you don't have access to it");
export const shareLinkNotFound = () =>
  notFound("That share link doesn't exist or you don't have access to it");
export const shareAdminOnly = () => forbidden("Only the baby's parents can share");
export const albumInTrash = () =>
  new ApiError(409, "conflict", "This album is in the trash. Restore it to share it again");

export interface ShareAdminAccess {
  babyId: string;
  role: BabyRole;
  trashed: boolean;
}

export interface AdminAccessOptions {
  /** Allow a trashed baby (list, revoke, delete, removals). Default: 409 for a trashed baby. */
  allowTrashed?: boolean;
  /** 404 message when the caller is not a member. */
  notFound?: () => ApiError;
}

/** The caller must be an admin of `babyId`: stranger 404, contributor 403 (role read only to pick the error). */
export async function requireShareAdmin(
  client: Tx,
  uid: string,
  babyId: string,
  opts: AdminAccessOptions = {},
): Promise<ShareAdminAccess> {
  const access = await babyAccess(client, uid, babyId);
  if (!access) throw (opts.notFound ?? shareBabyNotFound)();
  if (access.role !== "admin") throw shareAdminOnly();
  const trashed = access.deletedAt !== null;
  if (trashed && !opts.allowTrashed) throw albumInTrash();
  return { babyId, role: access.role, trashed };
}

/**
 * The baby of a share link, through `share_link_baby()` (SECURITY DEFINER: returns the baby for
 * any id), then the admin check on that baby: a stranger's or unknown id is 404 either way.
 */
export async function requireLinkAdmin(
  client: Tx,
  uid: string,
  linkId: string,
  opts: Omit<AdminAccessOptions, "notFound"> = {},
): Promise<ShareAdminAccess> {
  const { rows } = await client.query<{ baby_id: string | null }>(
    "SELECT public.share_link_baby($1) AS baby_id",
    [linkId],
  );
  const babyId = rows[0]?.baby_id;
  if (!babyId) throw shareLinkNotFound();
  return requireShareAdmin(client, uid, babyId, { ...opts, notFound: shareLinkNotFound });
}

/** `baby_ai_enabled()` (paid plan, entitlement not expired): auto-share rules need it (D3). */
export async function babyAiEnabled(client: Tx, babyId: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>("SELECT public.baby_ai_enabled($1) AS ok", [
    babyId,
  ]);
  return rows[0]?.ok === true;
}

// ---- links ----------------------------------------------------------------------------------------

/** `status` of a link, from the database clock. */
const STATUS_SQL = `CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked'
                         WHEN l.expires_at <= now() THEN 'expired'
                         ELSE 'active' END`;

/**
 * Album rows a viewer would list (same predicate as `viewer_photo_ids()`): approved, live,
 * unquarantined, and never a sensitive photo through a rule row. `sp`/`p` aliases.
 */
const LISTED_SQL = `p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
                    AND (NOT p.is_sensitive OR sp.added_by = 'user')`;
/** Listed but shown as a hidden tile: sensitive and not released for this link (D4). */
const HIDDEN_SQL = `p.is_sensitive AND NOT (sp.added_by = 'user' AND sp.sensitive_released_at IS NOT NULL)`;

const LINK_COLUMNS = `
  l.id, l.baby_id, l.name, ${STATUS_SQL} AS status, l.expires_at, l.revoked_at, l.ttl_hours,
  l.allow_download, l.has_passcode, public.share_link_passcode_locked(l.id) AS passcode_locked,
  l.view_count, l.last_viewed_at, l.created_at, l.created_by,
  r.mode AS rule_mode, r.include_tags AS rule_include_tags, r.exclude_tags AS rule_exclude_tags,
  r.updated_at AS rule_updated_at, r.evaluated_at AS rule_evaluated_at,
  (SELECT count(*) FROM public.shared_photos sp JOIN public.photos p ON p.id = sp.photo_id
    WHERE sp.share_link_id = l.id AND ${LISTED_SQL})::int AS photo_count,
  (SELECT count(*) FROM public.shared_photos sp JOIN public.photos p ON p.id = sp.photo_id
    WHERE sp.share_link_id = l.id AND ${LISTED_SQL} AND ${HIDDEN_SQL})::int AS hidden_count,
  (SELECT count(*) FROM public.viewer_sessions vs
    WHERE vs.share_link_id = l.id AND vs.revoked_at IS NULL AND vs.expires_at > now())::int
    AS active_viewers`;

export interface ShareLinkRow {
  id: string;
  baby_id: string;
  name: string;
  status: ShareLinkStatus;
  expires_at: Date;
  revoked_at: Date | null;
  ttl_hours: number;
  allow_download: boolean;
  has_passcode: boolean;
  passcode_locked: boolean;
  view_count: number;
  last_viewed_at: Date | null;
  created_at: Date;
  created_by: string | null;
  rule_mode: ShareRuleMode | null;
  rule_include_tags: string[] | null;
  rule_exclude_tags: string[] | null;
  rule_updated_at: Date | null;
  rule_evaluated_at: Date | null;
  photo_count: number;
  hidden_count: number;
  active_viewers: number;
}

/** The links of a baby (or one link), newest first, under the caller's claims. */
export async function loadShareLinks(
  client: Tx,
  babyId: string,
  linkId?: string,
): Promise<ShareLinkRow[]> {
  const { rows } = await client.query<ShareLinkRow>(
    `SELECT ${LINK_COLUMNS}
       FROM public.share_links l
       LEFT JOIN public.share_rules r ON r.share_link_id = l.id
      WHERE l.baby_id = $1 AND ($2::uuid IS NULL OR l.id = $2::uuid)
      ORDER BY l.created_at DESC, l.id DESC`,
    [babyId, linkId ?? null],
  );
  return rows;
}

/** One link (after `requireLinkAdmin`); 404 when RLS no longer shows it. */
export async function loadShareLink(
  client: Tx,
  babyId: string,
  linkId: string,
): Promise<ShareLink> {
  const row = (await loadShareLinks(client, babyId, linkId))[0];
  if (!row) throw shareLinkNotFound();
  return toShareLink(row);
}

export function toShareRule(r: {
  mode: ShareRuleMode;
  include_tags: string[];
  exclude_tags: string[];
  updated_at: Date;
  evaluated_at: Date | null;
}): ShareRule {
  return {
    mode: r.mode,
    includeTags: r.include_tags,
    excludeTags: r.exclude_tags,
    updatedAt: r.updated_at.toISOString(),
    evaluatedAt: r.evaluated_at?.toISOString() ?? null,
  };
}

export function toShareLink(r: ShareLinkRow): ShareLink {
  return {
    id: r.id,
    babyId: r.baby_id,
    name: r.name,
    status: r.status,
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
    ttlHours: r.ttl_hours,
    allowDownload: r.allow_download,
    hasPasscode: r.has_passcode,
    passcodeLocked: r.passcode_locked,
    rule:
      r.rule_mode && r.rule_updated_at
        ? toShareRule({
            mode: r.rule_mode,
            include_tags: r.rule_include_tags ?? [],
            exclude_tags: r.rule_exclude_tags ?? [],
            updated_at: r.rule_updated_at,
            evaluated_at: r.rule_evaluated_at,
          })
        : null,
    photoCount: r.photo_count,
    hiddenCount: r.hidden_count,
    viewCount: r.view_count,
    lastViewedAt: r.last_viewed_at?.toISOString() ?? null,
    activeViewers: r.active_viewers,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  };
}

// ---- keyset paging (both sides) -------------------------------------------------------------------

/** `photos.sort_at` as exact UTC text (microseconds), the step-5 cursor's sort key. */
export const SHARE_SORT_KEY_SQL = `to_char(p.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** `AND (p.sort_at, p.id) < (cursor)` with bind positions `$a`, `$b`, or nothing. */
export function keysetClause(
  cursor: PhotoCursor | null,
  firstParam: number,
): { sql: string; values: unknown[] } {
  if (!cursor) return { sql: "", values: [] };
  return {
    sql: `AND (p.sort_at, p.id) < ($${firstParam}::timestamptz, $${firstParam + 1}::uuid)`,
    values: [cursor.sortKey, cursor.id],
  };
}

// ---- viewer reads (role `viewer`, after viewer_session_check) -----------------------------------

/** Album header and counts under viewer RLS. */
export async function loadViewerAlbum(client: Tx, session: ViewerSession): Promise<ShareAlbum> {
  const { rows } = await client.query<{ photo_count: number; hidden_count: number }>(
    `SELECT count(*)::int AS photo_count,
            count(*) FILTER (WHERE ${HIDDEN_SQL})::int AS hidden_count
       FROM public.shared_photos sp
       JOIN public.photos p ON p.id = sp.photo_id
      WHERE sp.share_link_id = $1`,
    [session.shareLinkId],
  );
  return {
    linkName: session.linkName,
    babyName: session.babyName,
    babyNickname: session.babyNickname,
    allowDownload: session.allowDownload,
    expiresAt: session.expiresAt.toISOString(),
    photoCount: rows[0]?.photo_count ?? 0,
    hiddenCount: rows[0]?.hidden_count ?? 0,
  };
}

export interface ViewerPhotoRow {
  id: string;
  /** UTC calendar date `YYYY-MM-DD` (review-fixes D19): viewers get no time of day. */
  taken_at: string | null;
  taken_at_estimated: boolean;
  age_days: number | null;
  width: number | null;
  height: number | null;
  sort_key: string;
  hidden: boolean;
  milestone_id: string | null;
  milestone_name: string | null;
  /** `photo_derivatives.storage_key` of the thumb; RLS returns NULL for a hidden photo. */
  thumb_key: string | null;
}

/**
 * One page of the viewer's album, newest first (`sort_at DESC, id DESC`, `limit + 1` rows to
 * detect a next page). Only columns granted to `viewer` (no `deleted_at` / `approval`: the
 * `photos_viewer_select` policy already limits rows to live, approved, listable photos).
 */
export async function listViewerPhotoRows(
  client: Tx,
  session: ViewerSession,
  cursor: PhotoCursor | null,
  limit: number,
): Promise<ViewerPhotoRow[]> {
  const keyset = keysetClause(cursor, 4);
  const { rows } = await client.query<ViewerPhotoRow>(
    `SELECT p.id, to_char(p.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS taken_at,
            p.taken_at_estimated, p.age_days, p.width, p.height,
            ${SHARE_SORT_KEY_SQL} AS sort_key,
            (${HIDDEN_SQL}) AS hidden,
            pd.milestone_id, m.name AS milestone_name,
            t.storage_key AS thumb_key
       FROM public.shared_photos sp
       JOIN public.photos p ON p.id = sp.photo_id
       LEFT JOIN public.photo_details pd ON pd.photo_id = p.id
       LEFT JOIN public.milestones m ON m.id = pd.milestone_id
       LEFT JOIN public.photo_derivatives t ON t.photo_id = p.id AND t.kind = 'thumb'
      WHERE sp.share_link_id = $1 AND p.baby_id = $2
        ${keyset.sql}
      ORDER BY p.sort_at DESC, p.id DESC
      LIMIT $3`,
    [session.shareLinkId, session.babyId, limit + 1, ...keyset.values],
  );
  return rows;
}

/** Storage keys of one derivative kind for visible (not hidden) photos; others simply absent. */
export async function viewerDerivativeKeys(
  client: Tx,
  ids: readonly string[],
  kind: ViewerMediaKind,
): Promise<Array<{ photo_id: string; storage_key: string }>> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<{ photo_id: string; storage_key: string }>(
    `SELECT d.photo_id, d.storage_key
       FROM public.photo_derivatives d
      WHERE d.photo_id = ANY($1::uuid[]) AND d.kind = $2`,
    [ids, kind],
  );
  return rows;
}

/** The `display` key and date of one visible photo, for a download; null when hidden/unknown. */
export async function viewerDownloadRow(
  client: Tx,
  photoId: string,
): Promise<{ storage_key: string; day: string } | null> {
  const { rows } = await client.query<{ storage_key: string; day: string }>(
    `SELECT d.storage_key, to_char(p.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
       FROM public.photo_derivatives d
       JOIN public.photos p ON p.id = d.photo_id
      WHERE d.photo_id = $1 AND d.kind = 'display'`,
    [photoId],
  );
  return rows[0] ?? null;
}

/**
 * Object key shape of a viewer-servable derivative. Belt and braces on top of RLS: a key that is
 * not `…/derivatives/<uuid>/(thumb|display).jpg` is never signed.
 */
const VIEWER_KEY_RE = /^babies\/[0-9a-f-]{36}\/derivatives\/([0-9a-f-]{36})\/(thumb|display)\.jpg$/;

/** Sign a derivative key for a viewer; throws (500) for anything but this photo's thumb/display. */
export function signViewerKey(
  signer: UrlSigner,
  key: string,
  photoId: string,
  kind: ViewerMediaKind,
  ttlSec: number,
  contentDisposition?: string,
): Promise<SignedUrl> {
  const m = VIEWER_KEY_RE.exec(key);
  if (!m || m[1] !== photoId || m[2] !== kind) throw internalError();
  return signer.signGet(key, {
    ttlSec,
    ...(contentDisposition ? { contentDisposition } : {}),
  });
}

/** Row → `viewerPhoto`: a hidden photo never gets a URL, even if a key came back. */
export async function toViewerPhoto(
  signer: UrlSigner,
  r: ViewerPhotoRow,
  ttlSec: number,
): Promise<ViewerPhoto> {
  const thumb =
    !r.hidden && r.thumb_key
      ? await signViewerKey(signer, r.thumb_key, r.id, "thumb", ttlSec)
      : null;
  return {
    id: r.id,
    takenAt: r.taken_at,
    takenAtEstimated: r.taken_at_estimated,
    ageDays: r.age_days,
    width: r.width,
    height: r.height,
    milestone:
      r.milestone_id && r.milestone_name ? { id: r.milestone_id, name: r.milestone_name } : null,
    hidden: r.hidden,
    thumbUrl: thumb?.url ?? null,
    urlExpiresAt: thumb?.expiresAt.toISOString() ?? null,
  };
}

/**
 * Parse a viewer response with its strict shared schema before it is sent (fail closed): an
 * undeclared key (`babyId`, `caption`, `isSensitive`, a GPS field, an original URL) or a hidden
 * photo with a URL is a 500, never a leak. Logs field paths only.
 */
export function strictViewerBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
  log: FastifyBaseLogger,
): z.output<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  log.error(
    { fields: [...new Set(parsed.error.issues.map((i) => i.path.map(String).join(".")))] },
    "viewer response failed its schema",
  );
  throw internalError();
}

/** `added_by` as the API reports it. */
export function sharedBy(v: string): SharedPhotoAddedBy {
  return v === "rule" ? "rule" : "user";
}
