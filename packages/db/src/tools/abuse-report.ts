/**
 * Operator free-tier abuse report, per family (docs/plans/step-11.md, amended: 2.7, D-K;
 * docs/PRODUCTION.md Part J):
 *
 *   pnpm admin:abuse-report [--days N=7] [--limit N=20] [--show-emails] [--json]
 *   docker compose run --rm migrate pnpm admin:abuse-report --days 30
 *
 * Read-only (`BEGIN READ ONLY`) with the superuser `DATABASE_URL`. Six sections:
 * 1. family starts per network: `family_starts` grouped by keyed IP hash (first 12 hex characters
 *    shown) in the window, 3 or more starts, most first;
 * 2. families near or over the pool: approved, counting items across each family's free, live
 *    albums (the `photos_free_tier_cap` predicate), 800 or more, fullest first, `OVER` past 1,000;
 *    `videos` = the counting videos (Q3 sub-cap, `free_tier_video_limit()`), `VIDEOS` at or over it.
 *    Families under 800 items but at or over the video limit are listed too;
 * 3. top storage: albums and families by bytes of originals (every stored photo row: pending,
 *    trashed, Plus and quarantined included, until purged), top `--limit`, with `videos` and
 *    `video_bytes` (originals of `media_kind = 'video'`); a family at or over the Plus fair-use
 *    total (`PLUS_FAIR_USE_BYTES_PER_FAMILY`, 200 GiB, step 12 Q4) is marked `FAIR-USE` (operator
 *    information only, nothing is enforced);
 * 4. recent family starts (window): ledger rows with flags `plus_tag`, `dots_folded`,
 *    `canonical_dup` (another live account shares the founder's canonical inbox) and `suspended`
 *    (the founder or any parent of the family);
 * 5. pending queues: uploaders with live pending photos in one family at 50 % or more of
 *    `pending_photo_limit()`;
 * 6. canonical-inbox clusters: two or more live accounts with the same canonical address, how many
 *    of them are parents and in how many families (account ids only; the address itself is never
 *    printed, not even with `--show-emails`, which lists the accounts' own addresses).
 * Without `--show-emails` the output holds ids, counts, sizes, dates and flags only, never an
 * address (no `@`); with it, sections 2-6 gain an `emails` column and a personal-data warning.
 * Privacy constraint (user, step 11): the report never compares photos across accounts; nothing
 * here reads a photo digest, a perceptual fingerprint or a vector.
 *
 * The migrate image contains only this package (pg, node-pg-migrate, tsx): nothing here may
 * import another workspace package. Errors go through `redact.ts`.
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import { knownSecrets, requireDatabaseUrl } from "../env.js";
import { describeError } from "../redact.js";

const { Client } = pg;

/** The ledger keeps 30 days (`family_starts_prune`), so a longer window shows nothing more. */
export const MAX_DAYS = 30;
export const DEFAULT_DAYS = 7;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 1000;
/** Section 1 threshold. */
export const MIN_STARTS_PER_NETWORK = 3;
/** Section 2 threshold: 80 % of the 1,000-photo family pool. */
export const POOL_WATCH_FROM = 800;
export const FREE_TIER_PHOTO_LIMIT = 1000;
/**
 * Step 12 Q4: Plus fair-use total per family (200 GiB of originals), shown as a marker in
 * section 3 only; `PLUS_FAIR_USE_BYTES_PER_FAMILY` in `@tinyglow/shared` mirrors it.
 */
export const PLUS_FAIR_USE_BYTES_PER_FAMILY = 200 * 1024 * 1024 * 1024;
/** Section 5 threshold: this fraction of `pending_photo_limit()` (D-K). */
export const PENDING_WATCH_FRACTION = 0.5;
/** Text output lists at most this many rows of sections 4-6 (JSON lists all). */
export const TEXT_ROWS_MAX = 200;
/** Characters of the hex IP hash shown. */
export const NETWORK_ID_CHARS = 12;

export const USAGE =
  "usage: admin:abuse-report [--days 1-30 (default 7)] [--limit 1-1000 (default 20)] [--show-emails] [--json]";

export const PERSONAL_DATA_WARNING =
  "WARNING: --show-emails: this output contains personal data (email addresses). Read it on the server only; do not paste or store it.";

export interface ReportArgs {
  days: number;
  limit: number;
  showEmails: boolean;
  json: boolean;
}

/** Thrown for bad arguments (exit 2). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

function intArg(name: string, value: string | undefined, min: number, max: number): number {
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value\n${USAGE}`);
  }
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number\n${USAGE}`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}`);
  return n;
}

/** Parse `argv` (without the node/script entries). A leading literal `--` is ignored. */
export function parseReportArgs(argv: readonly string[]): ReportArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const out: ReportArgs = {
    days: DEFAULT_DAYS,
    limit: DEFAULT_LIMIT,
    showEmails: false,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--days") {
      out.days = intArg(arg, args[i + 1], 1, MAX_DAYS);
      i += 1;
    } else if (arg === "--limit") {
      out.limit = intArg(arg, args[i + 1], 1, MAX_LIMIT);
      i += 1;
    } else if (arg === "--show-emails") {
      out.showEmails = true;
    } else if (arg === "--json") {
      out.json = true;
    } else {
      throw new UsageError(`unexpected argument ${arg.startsWith("--") ? arg : ""}\n${USAGE}`);
    }
  }
  return out;
}

// ---- result shape ----------------------------------------------------------------------------

export interface NetworkRow {
  /** First `NETWORK_ID_CHARS` hex characters of the keyed IP hash. */
  network: string;
  starts: number;
  /** Distinct founders still on record (deleted accounts count as none). */
  accounts: number;
  firstAt: string;
  lastAt: string;
}

export interface FamilyPoolRow {
  familyId: string;
  /** Distinct admins across the family's albums (trashed albums included). */
  parents: number;
  freeAlbums: number;
  /** Approved, counting items (photos and videos) across the free, live albums. */
  photos: number;
  /** Of those, videos (the Q3 sub-cap). */
  videos: number;
  /** Live pending photos across the family's live albums (any uploader). */
  pending: number;
  /** Bytes of the counting items. */
  bytes: number;
  /** Percent of the 1,000-item pool, one decimal. */
  pct: number;
  over: boolean;
  /** At or over `free_tier_video_limit()`. */
  videosOver: boolean;
  /** Parents' addresses, comma-joined (`--show-emails` only). */
  emails?: string | null;
}

export interface StorageAlbumRow {
  babyId: string;
  familyId: string;
  plan: "free" | "plus";
  /** Every stored photo row of the album (videos included). */
  photos: number;
  /** Of those, `media_kind = 'video'`. */
  videos: number;
  pending: number;
  bytes: number;
  /** Bytes of the video originals. */
  videoBytes: number;
  trashed: boolean;
  emails?: string | null;
}

export interface StorageFamilyRow {
  familyId: string;
  parents: number;
  albums: number;
  photos: number;
  videos: number;
  bytes: number;
  videoBytes: number;
  /** `bytes >= PLUS_FAIR_USE_BYTES_PER_FAMILY` (Q4; information only). */
  fairUse: boolean;
  emails?: string | null;
}

export type FamilyStartFlag = "plus_tag" | "dots_folded" | "canonical_dup" | "suspended";

export interface FamilyStartRow {
  /** `null` once the family was purged. */
  familyId: string | null;
  /** `null` once the founder's account was deleted. */
  userId: string | null;
  createdAt: string;
  client: string;
  network: string;
  flags: FamilyStartFlag[];
  /** The founder's address (`--show-emails` only). */
  emails?: string | null;
}

export interface PendingQueueRow {
  familyId: string;
  userId: string;
  pending: number;
  emails?: string | null;
}

export interface CanonicalInboxRow {
  /** Live accounts sharing one canonical address, oldest first. */
  userIds: string[];
  accounts: number;
  /** How many of them are a parent somewhere. */
  parents: number;
  /** Distinct families those parents belong to. */
  families: number;
  firstAt: string;
  lastAt: string;
  emails?: string | null;
}

export interface AbuseReport {
  generatedAt: string;
  windowDays: number;
  limit: number;
  showEmails: boolean;
  /** `pending_photo_limit()` at report time. */
  pendingLimit: number;
  /** `free_tier_video_limit()` at report time (Q3). */
  videoLimit: number;
  /** `PLUS_FAIR_USE_BYTES_PER_FAMILY` (Q4), for the reader of the JSON. */
  fairUseBytes: number;
  familyStartsPerNetwork: NetworkRow[];
  families: FamilyPoolRow[];
  topStorage: { albums: StorageAlbumRow[]; families: StorageFamilyRow[] };
  recentFamilyStarts: FamilyStartRow[];
  pendingQueues: PendingQueueRow[];
  canonicalInboxes: CanonicalInboxRow[];
}

// ---- queries -------------------------------------------------------------------------------

/** Photos that count against a family pool: the `photos_free_tier_cap()` predicate (migration 21). */
const COUNTING = `p.approval = 'approved' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.status NOT IN ('failed', 'duplicate')`;
/** Live pending photos: the `photos_pending_cap()` predicate (migration 21). */
const PENDING = `p.approval = 'pending' AND p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.status NOT IN ('failed', 'duplicate')`;

/** Distinct admins of every album of the family `fam` (an SQL expression). */
const parentsCount = (fam: string) =>
  `(SELECT count(DISTINCT m.user_id)::int FROM public.babies pb
      JOIN public.baby_members m ON m.baby_id = pb.id AND m.role = 'admin'
     WHERE pb.family_id = ${fam})`;
/** The same parents' addresses, comma-joined, only when `flag` (an SQL boolean) is true. */
const parentEmails = (fam: string, flag: string) =>
  `CASE WHEN ${flag} THEN (SELECT string_agg(DISTINCT u.email::text, ', ' ORDER BY u.email::text)
      FROM public.babies pb
      JOIN public.baby_members m ON m.baby_id = pb.id AND m.role = 'admin'
      JOIN auth.users u ON u.id = m.user_id
     WHERE pb.family_id = ${fam}) END`;

const SQL_NETWORKS = `
  SELECT left(encode(s.ip_hash, 'hex'), ${NETWORK_ID_CHARS}) AS network,
         count(*)::int AS starts,
         count(DISTINCT s.user_id)::int AS accounts,
         min(s.created_at) AS first_at,
         max(s.created_at) AS last_at
    FROM public.family_starts s
   WHERE s.created_at > now() - make_interval(days => $1::int)
   GROUP BY s.ip_hash
  HAVING count(*) >= ${MIN_STARTS_PER_NETWORK}
   ORDER BY starts DESC, last_at DESC`;

/** A video row (step 12; `photos.media_kind`). */
const VIDEO = `p.media_kind = 'video'`;

const SQL_FAMILIES = `
  WITH pool AS (
    SELECT b.family_id,
           count(DISTINCT b.id)::int AS free_albums,
           count(p.id)::int AS photos,
           (count(p.id) FILTER (WHERE ${VIDEO}))::int AS videos,
           COALESCE(sum(p.bytes), 0)::text AS bytes
      FROM public.babies b
      LEFT JOIN public.photos p ON p.baby_id = b.id AND ${COUNTING}
     WHERE b.plan = 'free' AND b.deleted_at IS NULL
     GROUP BY b.family_id
    HAVING count(p.id) >= ${POOL_WATCH_FROM}
        OR count(p.id) FILTER (WHERE ${VIDEO}) >= $2::int
  )
  SELECT pool.family_id, pool.free_albums, pool.photos, pool.videos, pool.bytes,
         ${parentsCount("pool.family_id")} AS parents,
         (SELECT count(*)::int FROM public.babies b JOIN public.photos p ON p.baby_id = b.id
           WHERE b.family_id = pool.family_id AND b.deleted_at IS NULL AND ${PENDING}) AS pending,
         ${parentEmails("pool.family_id", "$1::boolean")} AS emails
    FROM pool
   ORDER BY pool.photos DESC, pool.videos DESC, pool.family_id`;

const SQL_TOP_ALBUMS = `
  SELECT b.id AS baby_id, b.family_id, b.plan,
         count(p.id)::int AS photos,
         (count(p.id) FILTER (WHERE ${VIDEO}))::int AS videos,
         (count(p.id) FILTER (WHERE ${PENDING}))::int AS pending,
         COALESCE(sum(p.bytes), 0)::text AS bytes,
         COALESCE(sum(p.bytes) FILTER (WHERE ${VIDEO}), 0)::text AS video_bytes,
         (b.deleted_at IS NOT NULL) AS trashed,
         CASE WHEN $2::boolean THEN (SELECT string_agg(u.email::text, ', ' ORDER BY u.email::text)
            FROM public.baby_members m JOIN auth.users u ON u.id = m.user_id
           WHERE m.baby_id = b.id AND m.role = 'admin') END AS emails
    FROM public.babies b
    LEFT JOIN public.photos p ON p.baby_id = b.id
   GROUP BY b.id
   ORDER BY COALESCE(sum(p.bytes), 0) DESC, photos DESC, b.id
   LIMIT $1`;

const SQL_TOP_FAMILIES = `
  WITH fam AS (
    SELECT b.family_id,
           count(DISTINCT b.id)::int AS albums,
           count(p.id)::int AS photos,
           (count(p.id) FILTER (WHERE ${VIDEO}))::int AS videos,
           COALESCE(sum(p.bytes), 0) AS bytes,
           COALESCE(sum(p.bytes) FILTER (WHERE ${VIDEO}), 0) AS video_bytes
      FROM public.babies b
      LEFT JOIN public.photos p ON p.baby_id = b.id
     GROUP BY b.family_id
     ORDER BY COALESCE(sum(p.bytes), 0) DESC, count(p.id) DESC, b.family_id
     LIMIT $1
  )
  SELECT fam.family_id, fam.albums, fam.photos, fam.videos, fam.bytes::text AS bytes,
         fam.video_bytes::text AS video_bytes,
         ${parentsCount("fam.family_id")} AS parents,
         ${parentEmails("fam.family_id", "$2::boolean")} AS emails
    FROM fam
   ORDER BY fam.bytes DESC, fam.photos DESC, fam.family_id`;

const SQL_RECENT_STARTS = `
  SELECT s.family_id, s.user_id, s.created_at, s.client,
         left(encode(s.ip_hash, 'hex'), ${NETWORK_ID_CHARS}) AS network,
         s.plus_tag, s.dots_folded,
         EXISTS (SELECT 1 FROM public.profiles fp
                   JOIN public.profiles q ON q.email_canonical = fp.email_canonical
                                         AND q.user_id <> fp.user_id AND q.deleted_at IS NULL
                  WHERE fp.user_id = s.user_id) AS canonical_dup,
         (EXISTS (SELECT 1 FROM public.profiles fp
                   WHERE fp.user_id = s.user_id AND fp.suspended_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM public.babies pb
                       JOIN public.baby_members m ON m.baby_id = pb.id AND m.role = 'admin'
                       JOIN public.profiles mp ON mp.user_id = m.user_id
                      WHERE pb.family_id = s.family_id AND mp.suspended_at IS NOT NULL)) AS suspended,
         CASE WHEN $2::boolean THEN (SELECT u.email::text FROM auth.users u WHERE u.id = s.user_id) END AS emails
    FROM public.family_starts s
   WHERE s.created_at > now() - make_interval(days => $1::int)
   ORDER BY s.created_at DESC, s.id DESC`;

const SQL_PENDING_QUEUES = `
  SELECT b.family_id, p.uploaded_by AS user_id, count(*)::int AS pending,
         CASE WHEN $2::boolean THEN (SELECT u.email::text FROM auth.users u WHERE u.id = p.uploaded_by) END AS emails
    FROM public.photos p
    JOIN public.babies b ON b.id = p.baby_id
   WHERE b.deleted_at IS NULL AND p.uploaded_by IS NOT NULL AND ${PENDING}
   GROUP BY b.family_id, p.uploaded_by
  HAVING count(*) >= $1::int
   ORDER BY pending DESC, b.family_id, p.uploaded_by`;

/** Grouped by the canonical value, which is never selected (it would print an address). */
const SQL_CANONICAL_INBOXES = `
  SELECT array_agg(p.user_id::text ORDER BY p.created_at, p.user_id) AS user_ids,
         count(*)::int AS accounts,
         (count(*) FILTER (WHERE public.parent_family_of(p.user_id) IS NOT NULL))::int AS parents,
         count(DISTINCT public.parent_family_of(p.user_id))::int AS families,
         min(p.created_at) AS first_at,
         max(p.created_at) AS last_at,
         CASE WHEN $2::boolean THEN string_agg(u.email::text, ', ' ORDER BY p.created_at, p.user_id) END AS emails
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.user_id
   WHERE p.email_canonical IS NOT NULL AND p.deleted_at IS NULL
   GROUP BY p.email_canonical
  HAVING count(*) >= 2
   ORDER BY parents DESC, accounts DESC, last_at DESC
   LIMIT $1`;

type Queryable = Pick<pg.Client, "query">;

const iso = (d: Date) => d.toISOString();
const num = (s: string | number) => Number(s);

/** Section 5 threshold for a given limit: at least 1. */
export function pendingWatchFrom(limit: number): number {
  return Math.max(1, Math.ceil(limit * PENDING_WATCH_FRACTION));
}

/** Run the six sections inside one read-only transaction on `client`. */
export async function collectReport(client: Queryable, args: ReportArgs): Promise<AbuseReport> {
  const limitRow = await client.query<{ limit: number; video_limit: number }>(
    'SELECT public.pending_photo_limit() AS "limit", public.free_tier_video_limit() AS video_limit',
  );
  const pendingLimit = limitRow.rows[0]?.limit ?? 200;
  const videoLimit = limitRow.rows[0]?.video_limit ?? 100;
  const networks = await client.query<{
    network: string;
    starts: number;
    accounts: number;
    first_at: Date;
    last_at: Date;
  }>(SQL_NETWORKS, [args.days]);
  const families = await client.query<{
    family_id: string;
    free_albums: number;
    photos: number;
    videos: number;
    bytes: string;
    parents: number;
    pending: number;
    emails: string | null;
  }>(SQL_FAMILIES, [args.showEmails, videoLimit]);
  const albums = await client.query<{
    baby_id: string;
    family_id: string;
    plan: "free" | "plus";
    photos: number;
    videos: number;
    pending: number;
    bytes: string;
    video_bytes: string;
    trashed: boolean;
    emails: string | null;
  }>(SQL_TOP_ALBUMS, [args.limit, args.showEmails]);
  const topFamilies = await client.query<{
    family_id: string;
    albums: number;
    photos: number;
    videos: number;
    bytes: string;
    video_bytes: string;
    parents: number;
    emails: string | null;
  }>(SQL_TOP_FAMILIES, [args.limit, args.showEmails]);
  const starts = await client.query<{
    family_id: string | null;
    user_id: string | null;
    created_at: Date;
    client: string;
    network: string;
    plus_tag: boolean;
    dots_folded: boolean;
    canonical_dup: boolean;
    suspended: boolean;
    emails: string | null;
  }>(SQL_RECENT_STARTS, [args.days, args.showEmails]);
  const queues = await client.query<{
    family_id: string;
    user_id: string;
    pending: number;
    emails: string | null;
  }>(SQL_PENDING_QUEUES, [pendingWatchFrom(pendingLimit), args.showEmails]);
  const inboxes = await client.query<{
    user_ids: string[];
    accounts: number;
    parents: number;
    families: number;
    first_at: Date;
    last_at: Date;
    emails: string | null;
  }>(SQL_CANONICAL_INBOXES, [args.limit, args.showEmails]);

  const withEmails = <T extends object>(row: T, emails: string | null): T =>
    args.showEmails ? { ...row, emails } : row;

  return {
    generatedAt: new Date().toISOString(),
    windowDays: args.days,
    limit: args.limit,
    showEmails: args.showEmails,
    pendingLimit,
    videoLimit,
    fairUseBytes: PLUS_FAIR_USE_BYTES_PER_FAMILY,
    familyStartsPerNetwork: networks.rows.map((r) => ({
      network: r.network,
      starts: r.starts,
      accounts: r.accounts,
      firstAt: iso(r.first_at),
      lastAt: iso(r.last_at),
    })),
    families: families.rows.map((r) =>
      withEmails<FamilyPoolRow>(
        {
          familyId: r.family_id,
          parents: r.parents,
          freeAlbums: r.free_albums,
          photos: r.photos,
          videos: r.videos,
          pending: r.pending,
          bytes: num(r.bytes),
          pct: Math.round((r.photos / FREE_TIER_PHOTO_LIMIT) * 1000) / 10,
          over: r.photos > FREE_TIER_PHOTO_LIMIT,
          videosOver: r.videos >= videoLimit,
        },
        r.emails,
      ),
    ),
    topStorage: {
      albums: albums.rows.map((r) =>
        withEmails<StorageAlbumRow>(
          {
            babyId: r.baby_id,
            familyId: r.family_id,
            plan: r.plan,
            photos: r.photos,
            videos: r.videos,
            pending: r.pending,
            bytes: num(r.bytes),
            videoBytes: num(r.video_bytes),
            trashed: r.trashed,
          },
          r.emails,
        ),
      ),
      families: topFamilies.rows.map((r) =>
        withEmails<StorageFamilyRow>(
          {
            familyId: r.family_id,
            parents: r.parents,
            albums: r.albums,
            photos: r.photos,
            videos: r.videos,
            bytes: num(r.bytes),
            videoBytes: num(r.video_bytes),
            fairUse: num(r.bytes) >= PLUS_FAIR_USE_BYTES_PER_FAMILY,
          },
          r.emails,
        ),
      ),
    },
    recentFamilyStarts: starts.rows.map((r) => {
      const flags: FamilyStartFlag[] = [];
      if (r.plus_tag) flags.push("plus_tag");
      if (r.dots_folded) flags.push("dots_folded");
      if (r.canonical_dup) flags.push("canonical_dup");
      if (r.suspended) flags.push("suspended");
      return withEmails<FamilyStartRow>(
        {
          familyId: r.family_id,
          userId: r.user_id,
          createdAt: iso(r.created_at),
          client: r.client,
          network: r.network,
          flags,
        },
        r.emails,
      );
    }),
    pendingQueues: queues.rows.map((r) =>
      withEmails<PendingQueueRow>(
        { familyId: r.family_id, userId: r.user_id, pending: r.pending },
        r.emails,
      ),
    ),
    canonicalInboxes: inboxes.rows.map((r) =>
      withEmails<CanonicalInboxRow>(
        {
          userIds: r.user_ids,
          accounts: r.accounts,
          parents: r.parents,
          families: r.families,
          firstAt: iso(r.first_at),
          lastAt: iso(r.last_at),
        },
        r.emails,
      ),
    ),
  };
}

// ---- text rendering --------------------------------------------------------------------------

/** `1536` → `1.5 KB`; binary units, one decimal from KB up. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

/** `2026-10-10T12:34:56.789Z` → `2026-10-10 12:34Z`. */
function shortTime(isoString: string): string {
  return `${isoString.slice(0, 10)} ${isoString.slice(11, 16)}Z`;
}

/** Fixed-width table: left-aligned text, right-aligned columns named in `right`. */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  right: ReadonlySet<string> = new Set(),
): string[] {
  if (rows.length === 0) return ["  (none)"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    `  ${cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        return right.has(headers[i] ?? "") ? c.padStart(w) : c.padEnd(w);
      })
      .join("  ")
      .trimEnd()}`;
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

const NUMERIC = new Set([
  "starts",
  "accounts",
  "parents",
  "free_albums",
  "albums",
  "photos",
  "videos",
  "pending",
  "bytes",
  "video_bytes",
  "pct",
  "families",
]);

function capped<T>(rows: readonly T[]): { shown: readonly T[]; more: number } {
  return { shown: rows.slice(0, TEXT_ROWS_MAX), more: Math.max(0, rows.length - TEXT_ROWS_MAX) };
}

export function renderText(report: AbuseReport): string {
  const out: string[] = [];
  const e = report.showEmails;
  const emails = (v: string | null | undefined) => (e ? [v ?? "-"] : []);
  const emailHeader = e ? ["emails"] : [];
  const more = (n: number) => {
    if (n > 0) out.push(`  ... ${n} more (use --json for all)`);
  };
  if (e) out.push(PERSONAL_DATA_WARNING, "");
  out.push(
    `Tinyglow free-tier abuse report (per family), generated ${shortTime(report.generatedAt)}, window ${report.windowDays} day(s), limit ${report.limit}`,
    "",
  );

  out.push(
    `1. Family starts per network (last ${report.windowDays} day(s), ${MIN_STARTS_PER_NETWORK} or more)`,
  );
  out.push(
    ...formatTable(
      ["network", "starts", "accounts", "first_at", "last_at"],
      report.familyStartsPerNetwork.map((r) => [
        r.network,
        String(r.starts),
        String(r.accounts),
        shortTime(r.firstAt),
        shortTime(r.lastAt),
      ]),
      NUMERIC,
    ),
    "",
  );

  out.push(
    `2. Families near or over the pool (${POOL_WATCH_FROM} or more of ${FREE_TIER_PHOTO_LIMIT} approved items, or ${report.videoLimit} or more videos)`,
  );
  out.push(
    ...formatTable(
      [
        "family_id",
        "parents",
        "free_albums",
        "photos",
        "videos",
        "pending",
        "bytes",
        "pct",
        "",
        ...emailHeader,
      ],
      report.families.map((r) => [
        r.familyId,
        String(r.parents),
        String(r.freeAlbums),
        String(r.photos),
        String(r.videos),
        String(r.pending),
        formatBytes(r.bytes),
        `${r.pct.toFixed(1)}%`,
        [r.over ? "OVER" : "", r.videosOver ? "VIDEOS" : ""].filter(Boolean).join(","),
        ...emails(r.emails),
      ]),
      NUMERIC,
    ),
    "",
  );

  out.push(
    `3. Top storage (originals; every stored photo and video incl. pending, trashed and Plus; top ${report.limit}; FAIR-USE at ${formatBytes(report.fairUseBytes)} per family, information only)`,
  );
  out.push("   Albums");
  out.push(
    ...formatTable(
      [
        "baby_id",
        "family_id",
        "plan",
        "photos",
        "videos",
        "pending",
        "bytes",
        "video_bytes",
        "trashed",
        ...emailHeader,
      ],
      report.topStorage.albums.map((r) => [
        r.babyId,
        r.familyId,
        r.plan,
        String(r.photos),
        String(r.videos),
        String(r.pending),
        formatBytes(r.bytes),
        formatBytes(r.videoBytes),
        r.trashed ? "yes" : "",
        ...emails(r.emails),
      ]),
      NUMERIC,
    ),
  );
  out.push("   Families");
  out.push(
    ...formatTable(
      [
        "family_id",
        "parents",
        "albums",
        "photos",
        "videos",
        "bytes",
        "video_bytes",
        "",
        ...emailHeader,
      ],
      report.topStorage.families.map((r) => [
        r.familyId,
        String(r.parents),
        String(r.albums),
        String(r.photos),
        String(r.videos),
        formatBytes(r.bytes),
        formatBytes(r.videoBytes),
        r.fairUse ? "FAIR-USE" : "",
        ...emails(r.emails),
      ]),
      NUMERIC,
    ),
    "",
  );

  const starts = capped(report.recentFamilyStarts);
  out.push(`4. Recent family starts (last ${report.windowDays} day(s))`);
  out.push(
    ...formatTable(
      ["family_id", "user_id", "created_at", "client", "network", "flags", ...emailHeader],
      starts.shown.map((r) => [
        r.familyId ?? "purged",
        r.userId ?? "deleted",
        shortTime(r.createdAt),
        r.client,
        r.network,
        r.flags.join(","),
        ...emails(r.emails),
      ]),
    ),
  );
  more(starts.more);
  out.push("");

  const queues = capped(report.pendingQueues);
  out.push(
    `5. Pending queues (${pendingWatchFrom(report.pendingLimit)} or more of ${report.pendingLimit} per uploader per family)`,
  );
  out.push(
    ...formatTable(
      ["family_id", "user_id", "pending", ...emailHeader],
      queues.shown.map((r) => [r.familyId, r.userId, String(r.pending), ...emails(r.emails)]),
      NUMERIC,
    ),
  );
  more(queues.more);
  out.push("");

  const inboxes = capped(report.canonicalInboxes);
  out.push(`6. Canonical-inbox clusters (2 or more live accounts; top ${report.limit})`);
  out.push(
    ...formatTable(
      ["accounts", "parents", "families", "first_at", "last_at", "user_ids", ...emailHeader],
      inboxes.shown.map((r) => [
        String(r.accounts),
        String(r.parents),
        String(r.families),
        shortTime(r.firstAt),
        shortTime(r.lastAt),
        r.userIds.join(","),
        ...emails(r.emails),
      ]),
      NUMERIC,
    ),
  );
  more(inboxes.more);
  return `${out.join("\n")}\n`;
}

// ---- entry -----------------------------------------------------------------------------------

export interface ReportOptions {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
}

/** Connect, run the report in one read-only transaction, disconnect. */
export async function abuseReport(
  args: ReportArgs,
  options: ReportOptions = {},
): Promise<AbuseReport> {
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl(env);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "tinyglow-abuse-report",
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const report = await collectReport(client, args);
    await client.query("COMMIT");
    return report;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the original error is what matters
    }
    throw new Error(`admin:abuse-report failed: ${describeError(err, knownSecrets(env))}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** CLI entry. Exit codes: 0 done, 1 failed, 2 usage. Production needs no flag: it only reads. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  let args: ReportArgs;
  try {
    args = parseReportArgs(argv);
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 2;
  }
  try {
    const report = await abuseReport(args, { env });
    if (args.json) {
      if (args.showEmails) console.error(PERSONAL_DATA_WARNING);
      write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      write(renderText(report));
    }
    return 0;
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main().then((code) => process.exit(code));
}
