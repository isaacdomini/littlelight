import {
  type DataExport,
  dataExportSchema,
  EXPORT_LIST_LIMIT,
  type ExportError,
  type ExportStatus,
} from "@littlelight/shared";
import type { Tx } from "../auth";

// `data_exports` reads and writes under the caller's claims (docs/plans/review-fixes.md 2.1 B,
// 2.5). Every statement names its columns: `storage_key` is not granted to `authenticated`, so
// `SELECT *` / `RETURNING *` would fail (and the key never belongs in a response; the download
// route recomputes it with `exportKey()`). Requester names come from `member_profiles` (co-member
// display names only; `profiles` is self-only for other users).

/** Columns of one export as an admin sees it (`$2` = the caller's uid). */
const EXPORT_COLUMNS = `
  e.id, e.baby_id, e.requested_by, e.include_location,
  CASE WHEN e.status = 'ready' AND (e.expires_at <= now() OR e.purged_at IS NOT NULL)
       THEN 'expired' ELSE e.status END AS status,
  e.error, e.photo_count, e.photos_done, e.bytes::text AS bytes,
  e.created_at, e.started_at, e.finished_at, e.expires_at,
  mp.display_name AS requested_by_name,
  COALESCE(e.requested_by = $2, false) AS is_mine,
  COALESCE(e.requested_by = $2, false) AND e.status = 'ready' AND e.expires_at > now()
    AND e.purged_at IS NULL AS can_download`;

const EXPORT_FROM = `
  FROM public.data_exports e
  LEFT JOIN public.member_profiles mp ON mp.user_id = e.requested_by`;

export interface ExportRow {
  id: string;
  baby_id: string;
  requested_by: string | null;
  include_location: boolean;
  /** Effective status: a `ready` export past its expiry (or purged) reads `expired`. */
  status: ExportStatus;
  error: ExportError | null;
  photo_count: number | null;
  photos_done: number;
  /** bigint as text (pg returns int8 as a string). */
  bytes: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date;
  requested_by_name: string | null;
  is_mine: boolean;
  can_download: boolean;
}

/** Row → wire DTO, parsed with the strict shared schema (an extra field fails closed). */
export function toDataExport(r: ExportRow): DataExport {
  return dataExportSchema.parse({
    id: r.id,
    babyId: r.baby_id,
    status: r.status,
    includeLocation: r.include_location,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    isMine: r.is_mine,
    photoCount: r.photo_count,
    photosDone: r.photos_done,
    bytes: r.bytes === null ? null : Number(r.bytes),
    error: r.error,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    expiresAt: r.expires_at.toISOString(),
    canDownload: r.can_download,
  });
}

/** The last `EXPORT_LIST_LIMIT` exports of a baby, newest first (RLS: admins of the baby). */
export async function listExports(client: Tx, babyId: string, uid: string): Promise<ExportRow[]> {
  const { rows } = await client.query<ExportRow>(
    `SELECT ${EXPORT_COLUMNS} ${EXPORT_FROM}
      WHERE e.baby_id = $1
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${EXPORT_LIST_LIMIT}`,
    [babyId, uid],
  );
  return rows;
}

/** One export of a baby (RLS: admins of the baby), or undefined. */
export async function loadExport(
  client: Tx,
  babyId: string,
  uid: string,
  exportId: string,
): Promise<ExportRow | undefined> {
  const { rows } = await client.query<ExportRow>(
    `SELECT ${EXPORT_COLUMNS} ${EXPORT_FROM}
      WHERE e.baby_id = $1 AND e.id = $3`,
    [babyId, uid, exportId],
  );
  return rows[0];
}

/**
 * Insert an export request for the caller. RLS (`is_baby_admin(baby_id) AND requested_by =
 * auth_uid()`) and the `data_exports_baby_live` / `data_exports_rate_limit` triggers decide;
 * their errors are mapped in `lib/errors.ts`. Returns the new id.
 */
export async function insertExport(
  client: Tx,
  babyId: string,
  uid: string,
  includeLocation: boolean,
): Promise<string | undefined> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.data_exports (baby_id, requested_by, include_location)
     VALUES ($1, $2, $3) RETURNING id`,
    [babyId, uid, includeLocation],
  );
  return rows[0]?.id;
}

/**
 * Count one download of the caller's own ready, unexpired, unpurged export. Returns false when
 * nothing matched (another admin's export, or it expired meanwhile).
 */
export async function recordDownload(
  client: Tx,
  babyId: string,
  uid: string,
  exportId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE public.data_exports
        SET downloads = downloads + 1, last_downloaded_at = now()
      WHERE id = $1 AND baby_id = $2 AND requested_by = $3
        AND status = 'ready' AND expires_at > now() AND purged_at IS NULL`,
    [exportId, babyId, uid],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Expire an export now (either admin). `LEAST` keeps an already-expired export's time (the
 * update guard refuses extensions). Returns whether this call shortened it (`false`: it was
 * already expired, or no such export is visible).
 */
export async function expireExport(client: Tx, babyId: string, exportId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE public.data_exports
        SET expires_at = LEAST(expires_at, now())
      WHERE id = $1 AND baby_id = $2 AND expires_at > now()`,
    [exportId, babyId],
  );
  return (rowCount ?? 0) > 0;
}

/** The baby's name (download file name only; never logged). */
export async function babyName(client: Tx, babyId: string): Promise<string | null> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM public.babies WHERE id = $1",
    [babyId],
  );
  return rows[0]?.name ?? null;
}

const FILENAME_MAX_SLUG = 40;

/**
 * `littlelight-<ascii baby name>-<YYYY-MM-DD>.zip` for `Content-Disposition`: diacritics folded,
 * anything but letters and digits collapsed to `-`, at most 40 chars, `album` when nothing is
 * left. The date is the export's creation day (UTC). Plain ASCII, so no quoting or RFC 5987
 * encoding is needed. Exported for tests.
 */
export function exportFileName(name: string | null, createdAt: Date): string {
  const slug = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, FILENAME_MAX_SLUG)
    .replace(/^-+|-+$/g, "");
  return `littlelight-${slug || "album"}-${createdAt.toISOString().slice(0, 10)}.zip`;
}
