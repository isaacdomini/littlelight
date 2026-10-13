import { randomUUID } from "node:crypto";
import {
  FREE_TIER_PHOTO_LIMIT,
  ingestJobSchema,
  type MediaKind,
  originalKey,
  type PhotoSummary,
  partCount,
  UPLOAD_MAX_FILES_PER_SESSION,
  UPLOAD_PART_BYTES,
  type UploadDetails,
  type UploadFile,
  type UploadFileError,
  type UploadFileRegister,
  type UploadFileState,
  type UploadPart,
  type UploadPartsResponse,
  type UploadSession,
  type UploadSessionCreate,
  type UploadSummary,
  videoLimitsFor,
} from "@tinyglow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { audit, requireConsent, type Tx, type TxContext, withClaims } from "../auth";
import {
  ApiError,
  forbidden,
  freeTierLimit,
  isPgError,
  notFound,
  pendingLimit,
} from "../lib/errors";
import {
  type BabyAccess,
  babyAccess,
  countMyPending,
  countPoolPhotos,
  countPoolVideos,
  freeTierVideoLimit,
  type PhotoSummaryRow,
  pendingPhotoLimit,
  photoRowsByIds,
  toPhotoSummary,
} from "../photos/queries";
import { errorCategory } from "../routes/healthz";
import { isInvalidParts, isNoSuchUpload, MultipartStorage } from "../storage/multipart";

// Upload sessions and pre-signed multipart uploads (docs/plans/step-4.md 2.1-2.5; PRD FR-2,
// FR-3.1, FR-6). Photo bytes never pass through the API: it books files in `upload_files`,
// creates/lists/completes/aborts multipart uploads with its own bucket-scoped MinIO account
// (no delete permission), signs part URLs on the public endpoint, and at completion inserts the
// `photos` row under the uploader's own claims (RLS forces `approval = 'pending'` for
// contributors) before enqueueing `photo.ingest` after commit.
//
// Every database statement runs under `withClaims` (RLS + the `upload_files_session_owner`
// trigger decide who may do what); S3 calls happen between transactions, never inside one. The
// client's `clientSha256`, `mime`, `takenAt` are hints only: the worker sniffs, re-hashes and
// reads EXIF. Nothing here logs hashes, keys, URLs, notes or request bodies; S3/pg failures are
// logged as categories only.
//
// Step 12 (docs/plans/step-12.md 2.4): videos use the same session and parts. At register the
// album plan's per-clip limits (`videoLimitsFor`: bytes ⇒ `file_too_large`, the client's
// `durationMs` hint ⇒ `video_too_long`) and the free family's video count (Q3 ⇒
// `free_tier_limit`) decide the outcome; `media_kind` / `declared_duration_ms` are stored, and
// complete inserts the photo row as `media_kind = 'video', rendition_status = 'pending'`.

type Req = Pick<FastifyRequest, "auth" | "server" | "log">;

/** Parallel S3 calls per request (CreateMultipartUpload for up to 100 files). */
const S3_CONCURRENCY = 8;

const sessionNotFound = () => notFound("That upload doesn't exist or you don't have access to it");
const fileNotFound = () => notFound("That file doesn't exist or you don't have access to it");
const notOwner = () => forbidden("Only the person who started this upload can change it");
const sessionExpired = () =>
  new ApiError(410, "upload_session_expired", "This upload session has ended");
const babyTrashed = () => new ApiError(409, "conflict", "This album is in the trash");

// ---- rows ---------------------------------------------------------------------------------------

interface SessionRow {
  id: string;
  baby_id: string;
  created_by: string;
  milestone_id: string | null;
  people: string[];
  note: string | null;
  location_label: string | null;
  finished_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

const SESSION_COLUMNS = `id, baby_id, created_by, milestone_id, people, note, location_label,
  finished_at, expires_at, created_at`;

interface FileRow {
  id: string;
  session_id: string;
  baby_id: string;
  client_id: string | null;
  state: UploadFileState;
  error: UploadFileError | null;
  /**
   * `declared_bytes` is a bigint (up to 2 GiB = 2147483648 for a video, one past int4's range),
   * read as `float8` so node-postgres hands back an exact JS number, never an int8 string.
   */
  declared_bytes: number;
  part_size: number;
  duplicate_of_photo_id: string | null;
  photo_id: string | null;
  storage_key: string;
  multipart_upload_id: string | null;
  client_sha256: string | null;
  client_mime: string | null;
  taken_at_hint: Date | null;
  /** Step 12: the registered kind (the worker's sniff is the truth). */
  media_kind: MediaKind;
  /** Step 12: the client's duration hint for a video (early `video_too_long` only). */
  declared_duration_ms: number | null;
}

const FILE_COLUMNS = `f.id, f.session_id, f.baby_id, f.client_id, f.state, f.error,
  f.declared_bytes::float8 AS declared_bytes, f.part_size, f.duplicate_of_photo_id, f.photo_id,
  f.storage_key, f.multipart_upload_id, encode(f.client_sha256, 'hex') AS client_sha256,
  f.client_mime, f.taken_at_hint, f.media_kind, f.declared_duration_ms`;

async function loadSession(client: Tx, sessionId: string): Promise<SessionRow | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM public.upload_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

async function loadFiles(client: Tx, sessionId: string): Promise<FileRow[]> {
  const { rows } = await client.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM public.upload_files f
      WHERE f.session_id = $1 ORDER BY f.created_at, f.id`,
    [sessionId],
  );
  return rows;
}

/** One file of one session with its session's owner and expiry; null when RLS hides it. */
async function loadFile(
  client: Tx,
  sessionId: string,
  fileId: string,
  opts: { lock?: boolean } = {},
): Promise<(FileRow & { created_by: string; expires_at: Date }) | null> {
  const { rows } = await client.query<FileRow & { created_by: string; expires_at: Date }>(
    `SELECT ${FILE_COLUMNS}, s.created_by, s.expires_at
       FROM public.upload_files f
       JOIN public.upload_sessions s ON s.id = f.session_id
      WHERE f.id = $1 AND f.session_id = $2
      ${opts.lock ? "FOR UPDATE OF f" : ""}`,
    [fileId, sessionId],
  );
  return rows[0] ?? null;
}

function isClosed(s: { finished_at: Date | null; expires_at: Date }, now = Date.now()): boolean {
  return s.finished_at !== null || s.expires_at.getTime() <= now;
}

function isExpired(s: { expires_at: Date }, now = Date.now()): boolean {
  return s.expires_at.getTime() <= now;
}

function detailsOf(s: SessionRow): UploadDetails {
  return {
    milestoneId: s.milestone_id,
    people: s.people ?? [],
    note: s.note,
    locationLabel: s.location_label,
  };
}

function hasDetails(s: SessionRow): boolean {
  return (
    s.milestone_id !== null ||
    (s.people?.length ?? 0) > 0 ||
    (s.note ?? "") !== "" ||
    (s.location_label ?? "") !== ""
  );
}

export function summarize(files: readonly Pick<FileRow, "state">[]): UploadSummary {
  const out: UploadSummary = {
    registered: 0,
    completed: 0,
    ingested: 0,
    duplicates: 0,
    failed: 0,
    aborted: 0,
  };
  for (const f of files) {
    if (f.state === "duplicate") out.duplicates++;
    else out[f.state]++;
  }
  return out;
}

function toUploadFile(f: FileRow, photo: PhotoSummary | null, parts?: UploadPart[]): UploadFile {
  return {
    id: f.id,
    clientId: f.client_id,
    kind: f.media_kind,
    state: f.state,
    error: f.error,
    bytes: f.declared_bytes,
    partSize: f.part_size,
    partCount: partCount(f.declared_bytes),
    duplicateOfPhotoId: f.duplicate_of_photo_id,
    photo,
    ...(parts ? { parts } : {}),
  };
}

/** Photo summaries (signed thumbs) for the files that have a photo, keyed by photo id. */
async function signPhotos(
  app: Pick<FastifyInstance, "signer">,
  rows: readonly PhotoSummaryRow[],
): Promise<Map<string, PhotoSummary>> {
  const out = new Map<string, PhotoSummary>();
  const summaries = await Promise.all(rows.map((r) => toPhotoSummary(app.signer, r)));
  for (const s of summaries) out.set(s.id, s);
  return out;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function storage(app: Pick<FastifyInstance, "s3" | "config">): MultipartStorage {
  return new MultipartStorage(app.s3, app.config.S3_BUCKET);
}

async function signParts(
  app: Pick<FastifyInstance, "signer">,
  key: string,
  uploadId: string,
  partNumbers: readonly number[],
): Promise<UploadPart[]> {
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: (await app.signer.signUploadPart(key, uploadId, partNumber)).url,
    })),
  );
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// ---- session view -------------------------------------------------------------------------------

interface SessionSnapshot {
  session: SessionRow;
  files: FileRow[];
  photos: PhotoSummaryRow[];
}

async function snapshot(client: Tx, session: SessionRow): Promise<SessionSnapshot> {
  const files = await loadFiles(client, session.id);
  const photoIds = files.flatMap((f) => (f.photo_id ? [f.photo_id] : []));
  return { session, files, photos: await photoRowsByIds(client, photoIds) };
}

async function toSessionView(
  app: Pick<FastifyInstance, "signer">,
  snap: SessionSnapshot,
): Promise<UploadSession> {
  const photos = await signPhotos(app, snap.photos);
  const s = snap.session;
  return {
    id: s.id,
    babyId: s.baby_id,
    createdAt: s.created_at.toISOString(),
    expiresAt: s.expires_at.toISOString(),
    finishedAt: s.finished_at?.toISOString() ?? null,
    details: detailsOf(s),
    summary: summarize(snap.files),
    files: snap.files.map((f) =>
      toUploadFile(f, f.photo_id ? (photos.get(f.photo_id) ?? null) : null),
    ),
  };
}

/** `GET /uploads/:sessionId`. */
export async function getSession(request: Req, sessionId: string): Promise<UploadSession> {
  const snap = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    const session = await loadSession(client, sessionId);
    if (!session) throw sessionNotFound();
    return snapshot(client, session);
  });
  return toSessionView(request.server, snap);
}

// ---- room (step 11) -----------------------------------------------------------------------------

interface UploadRoom {
  /** Photos this caller may still add here (`Infinity` when nothing limits it). */
  left: number;
  /** `upload_files.error` of a file refused for lack of room. */
  error: Extract<UploadFileError, "free_tier_limit" | "pending_limit">;
  refuse: () => ApiError;
}

/**
 * How many more photos the caller can upload into `babyId` (docs/plans/step-11.md 2.2 B–C, 2.5).
 * An admin's uploads are approved at insert, so they draw from the family's free pool (Plus
 * albums: no limit). A guest's uploads are pending and never count toward the pool; they are
 * bounded by the guest's pending queue in this family (every plan, D-C). Friendly pre-check only:
 * the triggers decide under their advisory locks.
 */
async function uploadRoom(client: Tx, babyId: string, access: BabyAccess): Promise<UploadRoom> {
  if (access.role === "admin") {
    if (access.plan !== "free") {
      return { left: Number.POSITIVE_INFINITY, error: "free_tier_limit", refuse: freeTierLimit };
    }
    const used = await countPoolPhotos(client, babyId);
    return { left: FREE_TIER_PHOTO_LIMIT - used, error: "free_tier_limit", refuse: freeTierLimit };
  }
  // One client, one query at a time (node-postgres deprecates concurrent queries on a client).
  const pending = await countMyPending(client, babyId);
  const limit = await pendingPhotoLimit(client);
  return {
    left: limit - pending,
    error: "pending_limit",
    refuse: () => pendingLimit({ pending, limit }),
  };
}

/** 409 `pending_limit` with the caller's counts when they can be read, else without. */
async function pendingLimitWithCounts(request: Req, babyId: string): Promise<ApiError> {
  try {
    return await withClaims(request, async (client) => {
      const pending = await countMyPending(client, babyId);
      const limit = await pendingPhotoLimit(client);
      return pendingLimit({ pending, limit });
    });
  } catch {
    return pendingLimit();
  }
}

// ---- create -------------------------------------------------------------------------------------

/** `POST /babies/:id/uploads`. */
export async function createSession(
  request: Req,
  babyId: string,
  body: UploadSessionCreate,
): Promise<UploadSession> {
  const d = body.details ?? {};
  const people = [...new Set(d.people ?? [])];
  const note = d.note ? d.note : null;
  const locationLabel = d.locationLabel ? d.locationLabel : null;
  const milestoneId = d.milestoneId ?? null;

  const session = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    const access = await babyAccess(client, ctx.uid, babyId);
    if (!access) throw notFound("That album doesn't exist or you don't have access to it");
    if (access.deletedAt) throw babyTrashed();
    // Friendly pre-check per role (step 11); the `photos_free_tier_cap` / `photos_pending_cap`
    // triggers are the hard stops.
    const room = await uploadRoom(client, babyId, access);
    if (room.left <= 0) throw room.refuse();
    if (milestoneId) {
      const { rows } = await client.query(
        "SELECT 1 FROM public.milestones WHERE id = $1 AND (baby_id IS NULL OR baby_id = $2)",
        [milestoneId, babyId],
      );
      if (rows.length === 0) {
        throw new ApiError(400, "validation_failed", "The request is invalid", {
          fields: ["body.details.milestoneId"],
        });
      }
    }
    const { rows } = await client.query<SessionRow>(
      `INSERT INTO public.upload_sessions
         (baby_id, created_by, milestone_id, people, note, location_label)
       VALUES ($1, $2, $3, $4::text[], $5, $6)
       RETURNING ${SESSION_COLUMNS}`,
      [babyId, ctx.uid, milestoneId, people, note, locationLabel],
    );
    const created = rows[0];
    if (!created) throw new ApiError(500, "internal", "Something went wrong");
    await audit(client, "upload.session_created", {
      babyId,
      actorUserId: ctx.uid,
      metadata: { session_id: created.id, client: request.auth?.clientKind ?? "web" },
    });
    return created;
  });
  return toSessionView(request.server, { session, files: [], photos: [] });
}

// ---- register -----------------------------------------------------------------------------------

type Outcome =
  | { kind: "reuse"; row: FileRow }
  | { kind: "duplicate"; of: string | null }
  | { kind: "failed"; error: UploadFileError }
  | { kind: "new" };

interface NewRow {
  id: string;
  input: UploadFileRegister;
  storageKey: string;
  uploadId: string | null;
  state: UploadFileState;
  error: UploadFileError | null;
  duplicateOf: string | null;
}

/** `POST /uploads/:sessionId/files`. */
export async function registerFiles(
  request: Req,
  sessionId: string,
  inputs: readonly UploadFileRegister[],
): Promise<UploadFile[]> {
  const app = request.server;

  // 1. Decide every file's outcome under the caller's claims.
  const planned = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    const session = await loadSession(client, sessionId);
    if (!session) throw sessionNotFound();
    if (session.created_by !== ctx.uid) throw notOwner();
    if (isClosed(session)) throw sessionExpired();
    const access = await babyAccess(client, ctx.uid, session.baby_id);
    if (!access) throw sessionNotFound();
    if (access.deletedAt) throw babyTrashed();

    const existing = await loadFiles(client, sessionId);
    const shas = [...new Set(inputs.flatMap((f) => (f.clientSha256 ? [f.clientSha256] : [])))];
    const live = new Map<string, string>();
    if (shas.length > 0) {
      const { rows } = await client.query<{ id: string; sha: string }>(
        `SELECT p.id, encode(p.sha256, 'hex') AS sha
           FROM public.photos p
          WHERE p.baby_id = $1 AND p.deleted_at IS NULL AND p.status <> 'duplicate'
            AND p.sha256 = ANY (SELECT decode(h, 'hex') FROM unnest($2::text[]) AS h)`,
        [session.baby_id, shas],
      );
      for (const r of rows) live.set(r.sha, r.id);
    }

    // Files registered but not yet completed will each become one photo (approved for an
    // admin, pending for a guest): they use up room too.
    const room = await uploadRoom(client, session.baby_id, access);
    const registered = existing.filter((f) => f.state === "registered").length;
    let headroom = room.left - registered;

    // Step 12 (docs/plans/step-12.md 2.4): per-clip limits of the album's plan, and the Q3 video
    // count for a free admin (approved videos across the family; a guest's pending videos never
    // count, exactly like the pool). Friendly pre-checks; `photos_free_tier_video_cap` and the
    // worker's ffprobe re-check are the hard stops.
    const videoLimits = videoLimitsFor(access.plan);
    const wantsVideo = inputs.some((f) => f.kind === "video");
    let videoHeadroom = Number.POSITIVE_INFINITY;
    if (wantsVideo && access.role === "admin" && access.plan === "free") {
      const videosUsed = await countPoolVideos(client, session.baby_id);
      const videoLimit = await freeTierVideoLimit(client);
      const registeredVideos = existing.filter(
        (f) => f.state === "registered" && f.media_kind === "video",
      ).length;
      videoHeadroom = videoLimit - videosUsed - registeredVideos;
    }

    const seen = new Set(
      existing.flatMap((f) =>
        f.client_sha256 && ["registered", "completed", "ingested"].includes(f.state)
          ? [f.client_sha256]
          : [],
      ),
    );
    const outcomes: Outcome[] = inputs.map((input) => {
      // Idempotent re-register (lost response, client retry): same client id, still open.
      const again = existing.find(
        (f) =>
          f.state === "registered" &&
          f.client_id === input.clientId &&
          f.declared_bytes === input.bytes &&
          f.media_kind === input.kind &&
          f.multipart_upload_id !== null &&
          (f.client_sha256 === null ||
            input.clientSha256 === undefined ||
            f.client_sha256 === input.clientSha256),
      );
      if (again) return { kind: "reuse", row: again };
      const sha = input.clientSha256;
      if (sha) {
        const of = live.get(sha);
        if (of) return { kind: "duplicate", of };
        if (seen.has(sha)) return { kind: "duplicate", of: null };
      }
      if (input.kind === "video") {
        if (input.bytes > videoLimits.maxBytes) return { kind: "failed", error: "file_too_large" };
        // Rounded whole seconds (a "1:00" phone clip is 60.x s): the worker's ffprobe check and
        // `import_book_photo` apply the same rule.
        if (
          input.durationMs !== undefined &&
          Math.round(input.durationMs / 1000) > videoLimits.maxSeconds
        ) {
          return { kind: "failed", error: "video_too_long" };
        }
        if (videoHeadroom <= 0) return { kind: "failed", error: "free_tier_limit" };
      }
      if (headroom <= 0) return { kind: "failed", error: room.error };
      headroom--;
      if (input.kind === "video") videoHeadroom--;
      if (sha) seen.add(sha);
      return { kind: "new" };
    });

    const adding = outcomes.filter((o) => o.kind !== "reuse").length;
    if (existing.length + adding > UPLOAD_MAX_FILES_PER_SESSION) {
      throw new ApiError(
        409,
        "upload_session_full",
        "This upload already has the maximum of 500 photos",
      );
    }
    return { babyId: session.baby_id, outcomes };
  });

  // 2. Multipart uploads for the new files, outside any transaction.
  const s3 = storage(app);
  const rows: (NewRow | null)[] = await mapLimit(
    planned.outcomes.map((o, i) => [o, inputs[i] as UploadFileRegister] as const),
    S3_CONCURRENCY,
    async ([o, input]) => {
      if (o.kind === "reuse") return null;
      const id = randomUUID();
      const storageKey = originalKey(planned.babyId, id);
      const base = { id, input, storageKey, uploadId: null, duplicateOf: null } as const;
      if (o.kind === "duplicate") {
        return { ...base, state: "duplicate", error: null, duplicateOf: o.of } satisfies NewRow;
      }
      if (o.kind === "failed") {
        return { ...base, state: "failed", error: o.error } satisfies NewRow;
      }
      try {
        const uploadId = await s3.create(storageKey);
        return { ...base, uploadId, state: "registered", error: null } satisfies NewRow;
      } catch (err) {
        request.log.warn({ err: errorCategory(err) }, "CreateMultipartUpload failed");
        return { ...base, state: "failed", error: "storage_error" } satisfies NewRow;
      }
    },
  );
  const created = rows.filter((r): r is NewRow => r !== null);

  // 3. Book them (the session-owner trigger re-checks owner, open session and the 500 cap).
  let inserted: FileRow[];
  try {
    inserted = await withClaims(request, async (client) => {
      if (created.length === 0) return [];
      const { rows: out } = await client.query<FileRow>(
        `INSERT INTO public.upload_files AS f
           (id, session_id, baby_id, client_id, declared_bytes, client_sha256, client_mime,
            taken_at_hint, tz_offset_hint_minutes, storage_key, multipart_upload_id, part_size,
            state, error, duplicate_of_photo_id, media_kind, declared_duration_ms)
         SELECT u.id, $1, $2, u.client_id, u.bytes, decode(u.sha, 'hex'), u.mime, u.taken_at,
                u.tz, u.storage_key, u.upload_id, $3, u.state, u.error, u.dup, u.media_kind,
                u.duration_ms
           FROM unnest($4::uuid[], $5::text[], $6::bigint[], $7::text[], $8::text[],
                       $9::timestamptz[], $10::smallint[], $11::text[], $12::text[], $13::text[],
                       $14::text[], $15::uuid[], $16::text[], $17::int[])
                AS u(id, client_id, bytes, sha, mime, taken_at, tz, storage_key, upload_id, state,
                     error, dup, media_kind, duration_ms)
         RETURNING ${FILE_COLUMNS}`,
        [
          sessionId,
          planned.babyId,
          UPLOAD_PART_BYTES,
          created.map((r) => r.id),
          created.map((r) => r.input.clientId),
          created.map((r) => r.input.bytes),
          created.map((r) => r.input.clientSha256 ?? null),
          created.map((r) => r.input.mime ?? null),
          created.map((r) => r.input.takenAt ?? null),
          created.map((r) => r.input.tzOffsetMinutes ?? null),
          created.map((r) => r.storageKey),
          created.map((r) => r.uploadId),
          created.map((r) => r.state),
          created.map((r) => r.error),
          created.map((r) => r.duplicateOf),
          created.map((r) => r.input.kind),
          created.map((r) => (r.input.kind === "video" ? (r.input.durationMs ?? null) : null)),
        ],
      );
      return out;
    });
  } catch (err) {
    // Nothing was booked: release the multipart uploads we just created (best effort; the
    // worker's sweep aborts any leftover after 48 h).
    await mapLimit(created, S3_CONCURRENCY, async (r) => {
      if (r.uploadId) await s3.abort(r.storageKey, r.uploadId).catch(() => undefined);
    });
    throw err;
  }

  // 4. Part URLs for every file that can be uploaded now.
  const byId = new Map(inserted.map((r) => [r.id, r]));
  let k = 0;
  return Promise.all(
    planned.outcomes.map(async (o) => {
      let row: FileRow | undefined;
      if (o.kind === "reuse") row = o.row;
      else {
        const created_ = created[k++];
        row = created_ ? byId.get(created_.id) : undefined;
      }
      if (!row) throw new ApiError(500, "internal", "Something went wrong");
      if (row.state === "registered" && row.multipart_upload_id) {
        const parts = await signParts(
          app,
          row.storage_key,
          row.multipart_upload_id,
          range(partCount(row.declared_bytes)),
        );
        return toUploadFile(row, null, parts);
      }
      return toUploadFile(row, null);
    }),
  );
}

// ---- parts (resume) -----------------------------------------------------------------------------

/** `GET /uploads/:sessionId/files/:fileId/parts`. */
export async function getParts(
  request: Req,
  sessionId: string,
  fileId: string,
): Promise<UploadPartsResponse> {
  const app = request.server;
  const s3 = storage(app);
  const file = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    const f = await loadFile(client, sessionId, fileId);
    if (!f) throw fileNotFound();
    if (f.created_by !== ctx.uid) throw notOwner();
    return f;
  });
  if (isExpired(file)) throw sessionExpired();

  // A file whose CreateMultipartUpload failed at registration (failed/storage_error, no upload
  // id) is revived here, so the client's "Retry" works without registering again.
  if (file.state === "failed" && file.error === "storage_error" && !file.multipart_upload_id) {
    const uploadId = await s3.create(file.storage_key);
    const revived = await withClaims(request, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE public.upload_files
            SET state = 'registered', error = NULL, multipart_upload_id = $3
          WHERE id = $1 AND session_id = $2 AND state = 'failed' AND multipart_upload_id IS NULL`,
        [fileId, sessionId, uploadId],
      );
      return (rowCount ?? 0) > 0;
    });
    if (!revived) {
      await s3.abort(file.storage_key, uploadId).catch(() => undefined);
      throw new ApiError(409, "conflict", "This file is no longer accepting uploads");
    }
    return {
      uploadedPartNumbers: [],
      parts: await signParts(
        app,
        file.storage_key,
        uploadId,
        range(partCount(file.declared_bytes)),
      ),
    };
  }

  if (file.state !== "registered" || !file.multipart_upload_id) {
    throw new ApiError(409, "conflict", "This file is no longer accepting uploads");
  }
  const total = partCount(file.declared_bytes);
  let uploaded: number[];
  try {
    uploaded = (await s3.listParts(file.storage_key, file.multipart_upload_id))
      .filter((p) => p.size === expectedPartSize(file, p.partNumber))
      .map((p) => p.partNumber);
  } catch (err) {
    if (!isNoSuchUpload(err)) throw err;
    // Swept or aborted elsewhere: the client registers the file again.
    await markFile(request, file, "aborted", "expired");
    throw fileNotFound();
  }
  const done = new Set(uploaded);
  return {
    uploadedPartNumbers: uploaded,
    parts: await signParts(
      app,
      file.storage_key,
      file.multipart_upload_id,
      range(total).filter((n) => !done.has(n)),
    ),
  };
}

/** Exact byte size part `n` must have: `part_size` except the last part. */
function expectedPartSize(f: Pick<FileRow, "declared_bytes" | "part_size">, n: number): number {
  const total = Math.ceil(f.declared_bytes / f.part_size);
  if (n < 1 || n > total) return -1;
  return n < total ? f.part_size : f.declared_bytes - (total - 1) * f.part_size;
}

/** Move a still-`registered` file to a terminal state (guarded, under the caller's claims). */
async function markFile(
  request: Req,
  file: Pick<FileRow, "id" | "session_id">,
  state: Extract<UploadFileState, "failed" | "aborted">,
  error: UploadFileError | null,
): Promise<void> {
  await withClaims(request, async (client) => {
    await client.query(
      `UPDATE public.upload_files SET state = $3, error = $4
        WHERE id = $1 AND session_id = $2 AND state = 'registered'`,
      [file.id, file.session_id, state, error],
    );
  });
}

// ---- complete -----------------------------------------------------------------------------------

async function fileView(request: Req, sessionId: string, fileId: string): Promise<UploadFile> {
  const loaded = await withClaims(request, async (client) => {
    const f = await loadFile(client, sessionId, fileId);
    if (!f) throw fileNotFound();
    const photos = f.photo_id ? await photoRowsByIds(client, [f.photo_id]) : [];
    return { f, photos };
  });
  const signed = await signPhotos(request.server, loaded.photos);
  return toUploadFile(loaded.f, loaded.f.photo_id ? (signed.get(loaded.f.photo_id) ?? null) : null);
}

/** `POST /uploads/:sessionId/files/:fileId/complete`. */
export async function completeFile(
  request: Req,
  sessionId: string,
  fileId: string,
): Promise<UploadFile> {
  const app = request.server;
  const s3 = storage(app);

  const file = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    const f = await loadFile(client, sessionId, fileId);
    if (!f) throw fileNotFound();
    if (f.created_by !== ctx.uid) throw notOwner();
    return f;
  });
  // Idempotent: a repeated complete (lost response) returns the file as it is now.
  if (file.state !== "registered") {
    if (file.state === "aborted") {
      throw new ApiError(409, "conflict", "This upload was cancelled");
    }
    return fileView(request, sessionId, fileId);
  }
  if (!file.multipart_upload_id) {
    throw new ApiError(409, "conflict", "This file is no longer accepting uploads");
  }

  // 1. Server-driven completion: the client never sends ETags.
  const total = partCount(file.declared_bytes);
  let completedEarlier = false;
  try {
    const listed = await s3.listParts(file.storage_key, file.multipart_upload_id);
    const byNumber = new Map(listed.map((p) => [p.partNumber, p]));
    const missing = range(total).filter((n) => byNumber.get(n)?.size !== expectedPartSize(file, n));
    if (missing.length > 0) {
      throw new ApiError(409, "upload_incomplete", "Some parts of this file are missing", {
        missingPartNumbers: missing,
      });
    }
    try {
      await s3.complete(
        file.storage_key,
        file.multipart_upload_id,
        range(total).map((n) => byNumber.get(n) as { partNumber: number; etag: string }),
      );
    } catch (err) {
      if (isInvalidParts(err)) {
        throw new ApiError(409, "upload_incomplete", "Some parts of this file are missing", {
          missingPartNumbers: range(total),
        });
      }
      if (!isNoSuchUpload(err)) throw err;
      completedEarlier = true;
    }
  } catch (err) {
    if (!isNoSuchUpload(err)) throw err;
    // The multipart upload is gone: a concurrent or earlier complete finished it (and possibly
    // crashed before booking it), or the sweep aborted it. HeadObject below tells which.
    completedEarlier = true;
  }

  // 2. The object must be exactly the declared size.
  const size = await s3.objectSize(file.storage_key);
  if (size !== file.declared_bytes) {
    if (completedEarlier && size === null) {
      const now = await fileView(request, sessionId, fileId);
      if (now.state !== "registered") return now;
    }
    // The api account cannot delete: purge.trash removes objects of failed files after an hour.
    await markFile(request, file, "failed", "upload_incomplete");
    return fileView(request, sessionId, fileId);
  }

  // 3. Book the photo under the uploader's own claims.
  let booked: { babyId: string; tzHint: string | null } | null;
  try {
    booked = await withClaims(request, (client, ctx) => bookPhoto(client, ctx, sessionId, fileId));
  } catch (err) {
    if (isPgError(err) && err.code === "23514" && err.message.startsWith("free tier photo limit")) {
      await markFile(request, file, "failed", "free_tier_limit");
      throw freeTierLimit();
    }
    // Step 12 (Q3): `photos_free_tier_video_cap` — the family's free albums hold the most videos.
    if (isPgError(err) && err.code === "23514" && err.message.startsWith("free tier video limit")) {
      await markFile(request, file, "failed", "free_tier_limit");
      throw freeTierLimit("video");
    }
    if (isPgError(err) && err.code === "23514" && err.message.startsWith("pending photo limit")) {
      await markFile(request, file, "failed", "pending_limit");
      throw await pendingLimitWithCounts(request, file.baby_id);
    }
    throw err;
  }

  // 4. After commit, outside runAs: enqueue ingest (failures are left to ingest.reconcile).
  if (booked) {
    const tz = ingestJobSchema.shape.tzHint.safeParse(booked.tzHint ?? undefined);
    await app.jobs.enqueueIngest({
      photoId: fileId,
      babyId: booked.babyId,
      uploadFileId: fileId,
      ...(tz.success && tz.data ? { tzHint: tz.data } : {}),
    });
  }
  return fileView(request, sessionId, fileId);
}

/**
 * Insert the `photos` row (+ batch `photo_details`) and mark the file `completed`, in one
 * transaction. Returns null when another request completed the file first.
 */
async function bookPhoto(
  client: Tx,
  ctx: TxContext,
  sessionId: string,
  fileId: string,
): Promise<{ babyId: string; tzHint: string | null } | null> {
  const f = await loadFile(client, sessionId, fileId, { lock: true });
  if (!f) throw fileNotFound();
  if (f.state !== "registered") return null;
  const access = await babyAccess(client, ctx.uid, f.baby_id);
  if (!access) throw fileNotFound();
  if (access.deletedAt) throw babyTrashed();
  // RLS (photos_authenticated_insert) only lets a contributor insert `pending`; an admin's own
  // uploads are approved. `mime` stays NULL until the worker sniffs the bytes.
  const approval = access.role === "admin" ? "approved" : "pending";
  // Step 12: the registered kind; a video row must start `rendition_status = 'pending'`
  // (`photos_media_shape`). The worker's sniff may still flip the kind.
  await client.query(
    `INSERT INTO public.photos
       (id, baby_id, uploaded_by, storage_key_original, mime, bytes, approval, taken_at,
        taken_at_estimated, media_kind, rendition_status)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, true, $8,
             CASE WHEN $8::text = 'video' THEN 'pending' ELSE 'none' END)`,
    [
      f.id,
      f.baby_id,
      ctx.uid,
      f.storage_key,
      f.declared_bytes,
      approval,
      f.taken_at_hint,
      f.media_kind,
    ],
  );
  const session = await loadSession(client, sessionId);
  if (session && hasDetails(session)) {
    await client.query(
      `INSERT INTO public.photo_details
         (photo_id, milestone_id, note, people, location_label, edited_by)
       VALUES ($1, $2, $3, $4::text[], $5, $6)`,
      [
        f.id,
        session.milestone_id,
        session.note,
        session.people ?? [],
        session.location_label,
        ctx.uid,
      ],
    );
  }
  await client.query(
    `UPDATE public.upload_files SET state = 'completed', photo_id = id
      WHERE id = $1 AND state = 'registered'`,
    [f.id],
  );
  const { rows } = await client.query<{ timezone: string | null }>(
    "SELECT timezone FROM public.profiles WHERE user_id = $1",
    [ctx.uid],
  );
  return { babyId: f.baby_id, tzHint: rows[0]?.timezone ?? null };
}

// ---- abort / finish -----------------------------------------------------------------------------

/** `DELETE /uploads/:sessionId/files/:fileId`. Idempotent for already aborted files. */
export async function abortFile(request: Req, sessionId: string, fileId: string): Promise<void> {
  const file = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    const f = await loadFile(client, sessionId, fileId, { lock: true });
    if (!f) throw fileNotFound();
    if (f.created_by !== ctx.uid) throw notOwner();
    if (f.state === "aborted") return null;
    if (f.state !== "registered" && !(f.state === "failed" && f.error === "storage_error")) {
      throw new ApiError(409, "conflict", "This file can no longer be cancelled");
    }
    await client.query(
      "UPDATE public.upload_files SET state = 'aborted', error = NULL WHERE id = $1",
      [fileId],
    );
    return f;
  });
  if (file?.multipart_upload_id) {
    // Best effort: the sweep aborts multipart uploads no registered file references.
    await storage(request.server)
      .abort(file.storage_key, file.multipart_upload_id)
      .catch((err: unknown) =>
        request.log.warn({ err: errorCategory(err) }, "AbortMultipartUpload failed"),
      );
  }
}

/** `POST /uploads/:sessionId/finish`. Idempotent. */
export async function finishSession(request: Req, sessionId: string): Promise<UploadSession> {
  const snap = await withClaims(request, async (client, ctx) => {
    await requireConsent(client, ctx);
    let session = await loadSession(client, sessionId);
    if (!session) throw sessionNotFound();
    if (session.created_by !== ctx.uid) throw notOwner();
    if (session.finished_at === null) {
      const { rows } = await client.query<SessionRow>(
        `UPDATE public.upload_sessions SET finished_at = now()
          WHERE id = $1 AND finished_at IS NULL
          RETURNING ${SESSION_COLUMNS}`,
        [sessionId],
      );
      if (rows[0]) {
        session = rows[0];
        const files = await loadFiles(client, sessionId);
        const sum = summarize(files);
        await audit(client, "upload.session_finished", {
          babyId: session.baby_id,
          actorUserId: ctx.uid,
          metadata: {
            session_id: sessionId,
            count: sum.completed + sum.ingested,
            duplicates: sum.duplicates,
            failed: sum.failed,
          },
        });
      }
    }
    return snapshot(client, session);
  });
  return toSessionView(request.server, snap);
}
