import {
  type MediaKind,
  type Plan,
  SYNC_LANE_CONCURRENCY,
  UPLOAD_CONCURRENCY,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES_PER_REQUEST,
  UPLOAD_MAX_FILES_PER_SESSION,
  type UploadDetails,
  type UploadFile,
  type UploadFileRegisterInput,
  uploadFileSchema,
  uploadFilesRegisterResponseSchema,
  uploadPartsResponseSchema,
  uploadSessionSchema,
  VIDEO_LARGE_FILE_BYTES,
} from "@tinyglow/shared";
import {
  getUploader,
  type NativeFileRef,
  PartUploadError,
  type PutPartOptions,
  type Uploader,
} from "../../platform/uploader";
import { ApiError, apiFetch, isApiError } from "../api";
import { pendingLimitMessage } from "../familyErrors";
import { readCaptureHint } from "./exif";
import { sha256Hex } from "./hash";
import { cellularForLargeVideos } from "./prefs";
import {
  acceptedMime,
  mediaKindOf,
  readVideoDuration,
  validateDuration,
  validateFile,
} from "./validate";

// Upload orchestration (docs/plans/step-4.md 2.12; videos: docs/plans/step-12.md 2.8). Plain
// class + useSyncExternalStore.
// Pipeline: prep (SHA-256 + EXIF hint for photos, duration read for videos; one file at a time)
// -> register (batched, <=100; sends `kind` and `durationMs`) -> upload (UPLOAD_CONCURRENCY
// files in flight, parts of one file sequential; part URLs re-fetched when older than 50 min)
// -> complete (the API lists the parts and completes; the client never needs ETags) -> poll
// until the worker ingests. Files that fail the client-side type/size/duration gate are shown
// as failed and never sent to the API.

export type ItemState =
  | "queued"
  | "hashing"
  | "registering"
  | "uploading"
  | "completing"
  | "completed"
  | "ingested"
  | "duplicate"
  | "failed"
  | "aborted";

/**
 * `unsupported` / `too_large` are client-side (`video_too_long` is both: the client's duration
 * read or the server's); the rest mirror `uploadFileError` + transport.
 */
export type ItemErrorCode =
  | "unsupported"
  | "too_large"
  | "unsupported_media_type"
  | "file_too_large"
  | "decode_failed"
  | "free_tier_limit"
  | "pending_limit"
  | "rejected"
  | "expired"
  | "storage_error"
  | "upload_incomplete"
  | "video_too_long"
  | "transcode_failed"
  /** Native uploader refusals (step 12 follow-up): no free disk / byte range outside the file. */
  | "no_space"
  | "bad_range"
  | "network"
  | "unknown";

/**
 * `user` = something the person just picked (shown on the Upload screen, goes first);
 * `sync` = background album sync (hidden from the Upload list, at most `SYNC_LANE_CONCURRENCY`
 * uploads at once, never delays a user item).
 */
export type UploadLane = "user" | "sync";

export interface UploadItem {
  clientId: string;
  /** Defaults to `user`. */
  lane: UploadLane;
  babyId: string;
  name: string;
  size: number;
  /** `photo` or `video` (from the mime/extension; the worker's sniff is the truth). */
  kind: MediaKind;
  /** A video's duration once read from its metadata (ms); undefined for photos / unreadable. */
  durationMs?: number;
  /** The album's plan when the caller knew it: drives the client-side video limits and copy. */
  plan?: Plan;
  /** Native: keep this transfer off cellular (large videos default to true, Q6). */
  wifiOnly: boolean;
  state: ItemState;
  /** 0..1 while uploading. */
  progress: number;
  error: ItemErrorCode | null;
  /** Counts-bearing text for `pending_limit` when the server sent them. */
  errorDetail?: string;
  /** True when "Retry" can succeed (transport/storage failures, not rejected files). */
  retryable: boolean;
}

export interface UploadSummaryCounts {
  uploaded: number;
  failed: number;
  duplicates: number;
  total: number;
  /** Items not yet in a terminal state. */
  active: number;
}

const TERMINAL: ReadonlySet<ItemState> = new Set(["ingested", "duplicate", "failed", "aborted"]);
const POLL_MS = 1500;
const PART_ATTEMPTS = 3;
const REGISTER_DEBOUNCE_MS = 100;
/** Presigned part URLs live 1 h; a long video upload asks for fresh ones after this long. */
const PART_URLS_MAX_AGE_MS = 50 * 60_000;

interface Runtime {
  /** The bytes. Native items hold none (null) except while hashing or a foreground multi-part PUT. */
  file: File | null;
  size: number;
  mime: string;
  /** Native only: the app-private copy of a picked/captured photo. */
  nativeRef: NativeFileRef | undefined;
  detailsKey: string;
  details: UploadDetails | undefined;
  kind: MediaKind;
  plan: Plan | undefined;
  durationMs: number | undefined;
  sha256: string | null;
  hint: { takenAt?: string; tzOffsetMinutes?: number };
  prepared: boolean;
  lane: UploadLane;
  /** Send over Wi-Fi only (native background session): sync lane, or a large video (Q6). */
  wifiOnly: boolean;
  sessionId: string | null;
  fileId: string | null;
  partSize: number;
  /** Fresh part URLs from the register response; undefined means "ask GET .../parts". */
  parts: { partNumber: number; url: string }[] | undefined;
  /** When `parts` were signed (register time), for the 50-minute refresh. */
  partsAt: number;
  abort: AbortController | null;
  cancelled: boolean;
}

interface SessionInfo {
  id: string;
  babyId: string;
  detailsKey: string;
  count: number;
  finishing: boolean;
}

interface ResumeRecord {
  sessionId: string;
  files: { sha256: string; size: number; fileId: string }[];
}

const resumeKey = (babyId: string) => `ll_upload:${babyId}`;

function readResume(babyId: string): ResumeRecord | null {
  try {
    const raw = window.localStorage.getItem(resumeKey(babyId));
    if (!raw) return null;
    const v = JSON.parse(raw) as ResumeRecord;
    return typeof v.sessionId === "string" && Array.isArray(v.files) ? v : null;
  } catch {
    return null;
  }
}

function writeResume(babyId: string, rec: ResumeRecord | null): void {
  try {
    if (rec && rec.files.length > 0) {
      window.localStorage.setItem(resumeKey(babyId), JSON.stringify(rec));
    } else {
      window.localStorage.removeItem(resumeKey(babyId));
    }
  } catch {
    // storage unavailable: resume is a convenience only
  }
}

export function hasResumableUpload(babyId: string): boolean {
  return readResume(babyId) !== null;
}

export function clearResumableUpload(babyId: string): void {
  writeResume(babyId, null);
}

// Native helpers load lazily so the web bundle never pulls Capacitor code.
async function readNativeFile(ref: NativeFileRef): Promise<File> {
  const { fileFromRef } = await import("../../platform/native/files");
  return fileFromRef(ref);
}

/** Duration hint for a native video; `undefined` on any failure (the worker's ffprobe is the truth). */
async function nativeVideoDuration(ref: NativeFileRef): Promise<number | undefined> {
  try {
    const m = await import("../../platform/native/files");
    return await m.nativeVideoDuration(ref);
  } catch {
    return undefined;
  }
}

function releaseNativeCopy(ref: NativeFileRef): void {
  void import("../../platform/native/files").then((m) => m.deleteNativeCopy(ref)).catch(() => {});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The duplicate pre-check hint. `sha256Hex` reads the whole file into memory, so files above the
 * photo cap (large videos) skip it: the worker hashes while staging and dedupes there.
 */
function hashFor(file: Blob): Promise<string | null> {
  return file.size > UPLOAD_MAX_FILE_BYTES ? Promise.resolve(null) : sha256Hex(file);
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function errorCodeFor(e: unknown): { code: ItemErrorCode; retryable: boolean } {
  if (e instanceof PartUploadError && e.reason) {
    return { code: e.reason === "no-space" ? "no_space" : "bad_range", retryable: false };
  }
  if (e instanceof ApiError) {
    if (e.code === "free_tier_limit") return { code: "free_tier_limit", retryable: false };
    if (e.code === "pending_limit") return { code: "pending_limit", retryable: false };
    if (e.code === "file_too_large") return { code: "file_too_large", retryable: false };
    if (e.code === "unsupported_media_type") {
      return { code: "unsupported_media_type", retryable: false };
    }
    if (e.code === "upload_session_expired") return { code: "expired", retryable: true };
    if (e.status === 0 || e.code === "network") return { code: "network", retryable: true };
    return { code: "unknown", retryable: e.status >= 500 };
  }
  return { code: "network", retryable: true };
}

/** Opaque per-file id (stored server-side as upload_files.client_id): never derived from a file name. */
function opaqueId(n: number): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${n}-${rand}`;
}

export interface UploadManagerOptions {
  uploader?: () => Uploader;
}

export interface AddOptions {
  /** The album's plan: per-clip video limits are applied client-side when known. */
  plan?: Plan;
}

/**
 * Q6: native items above `VIDEO_LARGE_FILE_BYTES` default to Wi-Fi only unless told otherwise, or
 * unless the persisted "Use cellular for large videos" preference is on (Settings -> Uploads).
 */
function defaultWifiOnly(size: number, explicit: boolean | undefined, native: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return native && size > VIDEO_LARGE_FILE_BYTES && !cellularForLargeVideos();
}

export class UploadManager {
  private snapshot: readonly UploadItem[] = [];
  private readonly rt = new Map<string, Runtime>();
  private readonly listeners = new Set<() => void>();
  private readonly photoListeners = new Set<(babyId: string) => void>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly currentSession = new Map<string, string>();
  private readonly sessionCreation = new Map<string, Promise<SessionInfo>>();
  private readonly uploadQueue: string[] = [];
  private activeUploads = 0;
  private activeSync = 0;
  private prepRunning = false;
  private registerTimer: ReturnType<typeof setTimeout> | null = null;
  private registering = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private counter = 0;
  private readonly uploader: () => Uploader;

  constructor(opts: UploadManagerOptions = {}) {
    this.uploader = opts.uploader ?? getUploader;
  }

  // ---- store -----------------------------------------------------------------------------

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): readonly UploadItem[] => this.snapshot;

  /** Called (at most once per poll/complete) when photos may have changed for a baby. */
  onPhotosChanged(cb: (babyId: string) => void): () => void {
    this.photoListeners.add(cb);
    return () => this.photoListeners.delete(cb);
  }

  private emitPhotos(babyId: string) {
    for (const cb of this.photoListeners) cb(babyId);
  }

  private patch(clientId: string, change: Partial<UploadItem>) {
    if (change.state && this.endsNativeNeed(change)) this.releaseNative(clientId);
    this.snapshot = this.snapshot.map((i) => (i.clientId === clientId ? { ...i, ...change } : i));
    for (const l of this.listeners) l();
  }

  /** The photo's bytes are no longer needed on this device (uploaded, rejected or cancelled). */
  private endsNativeNeed(change: Partial<UploadItem>): boolean {
    const s = change.state;
    return (
      s === "completed" ||
      s === "ingested" ||
      s === "duplicate" ||
      s === "aborted" ||
      (s === "failed" && change.retryable !== true)
    );
  }

  private releaseNative(clientId: string) {
    const r = this.rt.get(clientId);
    if (r?.nativeRef) {
      // Sync exports live outside ll-uploads; the sync manager discards them natively.
      if (r.lane !== "sync") releaseNativeCopy(r.nativeRef);
      r.nativeRef = undefined;
      r.file = null;
    }
  }

  private item(clientId: string): UploadItem | undefined {
    return this.snapshot.find((i) => i.clientId === clientId);
  }

  private fail(clientId: string, code: ItemErrorCode, retryable: boolean, cause?: unknown) {
    // Sync items are never retried in place: the sync run records the failure in its ledger and
    // the asset is offered again by a later run (up to the attempt limit).
    if (this.item(clientId)?.lane === "sync") retryable = false;
    this.patch(clientId, {
      state: "failed",
      error: code,
      errorDetail: (code === "pending_limit" && pendingLimitMessage(cause)) || undefined,
      retryable,
      progress: 0,
    });
    const r = this.rt.get(clientId);
    if (r) r.abort = null;
    this.afterChange(clientId);
  }

  // ---- adding files ----------------------------------------------------------------------

  /**
   * Native: queue picked/captured photos by reference. Bytes are read one file at a time for the
   * SHA-256 + EXIF hint and then released; the PUT streams from disk in the background.
   */
  addNative(
    babyId: string,
    refs: NativeFileRef[],
    details?: UploadDetails,
    opts: AddOptions & { lane?: UploadLane; wifiOnly?: boolean } = {},
  ): string[] {
    const lane = opts.lane ?? "user";
    const detailsKey = JSON.stringify(details ?? {});
    const added: UploadItem[] = [];
    const ids: string[] = [];
    let needsRegister = false;
    for (const ref of refs) {
      const clientId = opaqueId(++this.counter);
      ids.push(clientId);
      const kind = mediaKindOf({ name: ref.name, type: ref.mime });
      const durationMs = ref.durationMs;
      const reason =
        validateFile({ name: ref.name, size: ref.size, type: ref.mime }, opts.plan) ??
        (kind === "video" ? validateDuration(durationMs, opts.plan) : null);
      // The platform already hashed it (album sync): skip our own SHA-256 + EXIF read. A video
      // with a platform duration also skips the metadata read.
      const known = !reason && ref.sha256 ? ref.sha256 : null;
      const wifiOnly = defaultWifiOnly(ref.size, opts.wifiOnly, true);
      added.push({
        clientId,
        lane,
        babyId,
        name: ref.name,
        size: ref.size,
        kind,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(opts.plan ? { plan: opts.plan } : {}),
        wifiOnly,
        state: reason ? "failed" : known ? "registering" : "queued",
        progress: 0,
        error: reason,
        retryable: false,
      });
      if (reason) {
        if (lane !== "sync") releaseNativeCopy(ref);
      } else {
        const r = this.newRuntime(null, detailsKey, details, kind, opts.plan);
        r.nativeRef = ref;
        r.size = ref.size;
        r.mime = ref.mime;
        r.lane = lane;
        r.wifiOnly = wifiOnly;
        r.durationMs = durationMs;
        if (known) {
          r.sha256 = known;
          r.hint = ref.takenAt ? { takenAt: ref.takenAt } : {};
          r.prepared = true;
          needsRegister = true;
        }
        this.rt.set(clientId, r);
      }
    }
    this.snapshot = [...this.snapshot, ...added];
    for (const l of this.listeners) l();
    if (needsRegister) this.scheduleRegister();
    this.kickPrep();
    return ids;
  }

  /** Queue files for a baby. Rejected files appear as failed and are never sent to the API. */
  add(babyId: string, files: File[], details?: UploadDetails, opts: AddOptions = {}): void {
    const detailsKey = JSON.stringify(details ?? {});
    const added: UploadItem[] = [];
    for (const file of files) {
      const clientId = opaqueId(++this.counter);
      const kind = mediaKindOf(file);
      const reason = validateFile(file, opts.plan);
      const item: UploadItem = {
        clientId,
        lane: "user",
        babyId,
        name: file.name,
        size: file.size,
        kind,
        ...(opts.plan ? { plan: opts.plan } : {}),
        wifiOnly: false,
        state: reason ? "failed" : "queued",
        progress: 0,
        error: reason,
        retryable: false,
      };
      added.push(item);
      if (!reason) {
        this.rt.set(clientId, this.newRuntime(file, detailsKey, details, kind, opts.plan));
      }
    }
    this.snapshot = [...this.snapshot, ...added];
    for (const l of this.listeners) l();
    this.kickPrep();
  }

  private newRuntime(
    file: File | null,
    detailsKey: string,
    details: UploadDetails | undefined,
    kind: MediaKind,
    plan: Plan | undefined,
  ): Runtime {
    return {
      file,
      size: file?.size ?? 0,
      mime: file?.type ?? "",
      nativeRef: undefined,
      detailsKey,
      details,
      kind,
      plan,
      durationMs: undefined,
      sha256: null,
      hint: {},
      prepared: false,
      lane: "user",
      wifiOnly: false,
      sessionId: null,
      fileId: null,
      partSize: 0,
      parts: undefined,
      partsAt: 0,
      abort: null,
      cancelled: false,
    };
  }

  /**
   * After a reload: match re-picked files to the stored session by SHA-256 + size, skip the
   * ones the server already has, resume the registered ones through `GET .../parts`, and upload
   * the rest normally.
   */
  async resume(
    babyId: string,
    files: File[],
    details?: UploadDetails,
    opts: AddOptions = {},
  ): Promise<void> {
    const stored = readResume(babyId);
    if (!stored) {
      this.add(babyId, files, details, opts);
      return;
    }
    let session: ReturnType<typeof uploadSessionSchema.parse> | null = null;
    try {
      session = await apiFetch(`/uploads/${stored.sessionId}`, { schema: uploadSessionSchema });
    } catch {
      session = null;
    }
    if (!session || session.finishedAt !== null || Date.parse(session.expiresAt) < Date.now()) {
      writeResume(babyId, null);
      this.add(babyId, files, details, opts);
      return;
    }
    const detailsKey = JSON.stringify(session.details ?? {});
    const info: SessionInfo = {
      id: session.id,
      babyId,
      detailsKey,
      count: session.files.length,
      finishing: false,
    };
    this.sessions.set(info.id, info);
    this.currentSession.set(babyId, info.id);

    const rest: File[] = [];
    const added: UploadItem[] = [];
    const claimed = new Set<string>();
    for (const file of files) {
      const reason = validateFile(file, opts.plan);
      if (reason) {
        rest.push(file);
        continue;
      }
      const sha = await hashFor(file);
      const match = sha
        ? stored.files.find(
            (f) => f.sha256 === sha && f.size === file.size && !claimed.has(f.fileId),
          )
        : undefined;
      const sf = match ? session.files.find((f) => f.id === match.fileId) : undefined;
      if (
        !match ||
        !sf ||
        !["registered", "completed", "ingested", "duplicate"].includes(sf.state)
      ) {
        rest.push(file);
        continue;
      }
      claimed.add(match.fileId);
      const clientId = opaqueId(++this.counter);
      const kind = mediaKindOf(file);
      const r = this.newRuntime(file, detailsKey, session.details, kind, opts.plan);
      r.sha256 = sha;
      r.prepared = true;
      r.sessionId = session.id;
      r.fileId = sf.id;
      r.partSize = sf.partSize;
      this.rt.set(clientId, r);
      const state: ItemState = sf.state === "registered" ? "queued" : (sf.state as ItemState);
      added.push({
        clientId,
        lane: "user",
        babyId,
        name: file.name,
        size: file.size,
        kind: sf.kind,
        ...(opts.plan ? { plan: opts.plan } : {}),
        wifiOnly: false,
        state,
        progress: 0,
        error: null,
        retryable: false,
      });
      if (sf.state === "registered") this.uploadQueue.push(clientId);
    }
    this.snapshot = [...this.snapshot, ...added];
    for (const l of this.listeners) l();
    this.pumpUploads();
    this.schedulePoll();
    if (rest.length > 0) this.add(babyId, rest, details, opts);
    else this.maybeFinish(session.id);
  }

  // ---- prep: hash + EXIF hint (one file at a time) ----------------------------------------

  private kickPrep() {
    if (this.prepRunning) return;
    this.prepRunning = true;
    void (async () => {
      try {
        for (;;) {
          const waiting = this.snapshot.filter(
            (i) => i.state === "queued" && this.rt.get(i.clientId)?.prepared === false,
          );
          const next = waiting.find((i) => i.lane === "user") ?? waiting[0];
          if (!next) break;
          const r = this.rt.get(next.clientId);
          if (!r) break;
          this.patch(next.clientId, { state: "hashing" });
          if (r.kind === "video" && r.nativeRef) {
            // Native videos are never read into the WebView (a full-file fetch of a mov/mp4 fails
            // on iOS and would hold a 2 GB clip in memory on Android): no client hash (the worker
            // hashes while staging and dedupes there); the duration comes from the picker, or
            // from a metadata-only <video> on the file URL; the ranged `putFile` streams the bytes.
            const durationMs =
              r.durationMs !== undefined ? r.durationMs : await nativeVideoDuration(r.nativeRef);
            r.sha256 = null;
            r.durationMs = durationMs;
            if (durationMs !== undefined) this.patch(next.clientId, { durationMs });
            const tooLong = validateDuration(durationMs, r.plan);
            r.prepared = true;
            if (tooLong) {
              this.fail(next.clientId, tooLong, false);
              continue;
            }
            if (r.cancelled) continue;
            this.patch(next.clientId, { state: "registering" });
            this.scheduleRegister();
            continue;
          }
          let file = r.file;
          if (!file && r.nativeRef) {
            try {
              file = await readNativeFile(r.nativeRef);
            } catch {
              this.fail(next.clientId, "unknown", false);
              continue;
            }
          }
          if (!file) break;
          if (r.kind === "video") {
            // No EXIF in a video container; the duration hint comes from the browser's demuxer.
            const [sha, durationMs] = await Promise.all([
              hashFor(file),
              r.durationMs === undefined ? readVideoDuration(file) : Promise.resolve(r.durationMs),
            ]);
            r.sha256 = sha;
            r.durationMs = durationMs;
            if (durationMs !== undefined) this.patch(next.clientId, { durationMs });
            const tooLong = validateDuration(durationMs, r.plan);
            if (tooLong) {
              r.prepared = true;
              if (r.nativeRef) r.file = null;
              this.fail(next.clientId, tooLong, false);
              continue;
            }
          } else {
            const [sha, hint] = await Promise.all([hashFor(file), readCaptureHint(file)]);
            r.sha256 = sha;
            r.hint = hint;
          }
          r.prepared = true;
          if (r.nativeRef) r.file = null; // release the bytes; the PUT streams from disk
          if (r.cancelled) continue;
          this.patch(next.clientId, { state: "registering" });
          this.scheduleRegister();
        }
      } finally {
        this.prepRunning = false;
      }
    })();
  }

  // ---- register (batched) -----------------------------------------------------------------

  private scheduleRegister() {
    if (this.registerTimer) return;
    this.registerTimer = setTimeout(() => {
      this.registerTimer = null;
      void this.registerAll();
    }, REGISTER_DEBOUNCE_MS);
  }

  private pendingRegistration(): UploadItem[] {
    return this.snapshot.filter((i) => {
      const r = this.rt.get(i.clientId);
      return i.state === "registering" && r && r.prepared && r.fileId === null && !r.cancelled;
    });
  }

  private async registerAll() {
    if (this.registering) {
      this.scheduleRegister();
      return;
    }
    this.registering = true;
    try {
      for (;;) {
        const pending = this.pendingRegistration();
        const first = pending[0];
        if (!first) break;
        const firstRt = this.rt.get(first.clientId);
        if (!firstRt) break;
        const group = pending
          .filter(
            (i) =>
              i.babyId === first.babyId &&
              this.rt.get(i.clientId)?.detailsKey === firstRt.detailsKey,
          )
          .slice(0, UPLOAD_MAX_FILES_PER_REQUEST);
        await this.registerGroup(first.babyId, firstRt.detailsKey, firstRt.details, group, false);
      }
    } finally {
      this.registering = false;
    }
  }

  private async ensureSession(
    babyId: string,
    detailsKey: string,
    details: UploadDetails | undefined,
  ): Promise<SessionInfo> {
    const key = `${babyId}|${detailsKey}`;
    const existing = this.sessions.get(this.currentSession.get(babyId) ?? "");
    if (
      existing &&
      existing.detailsKey === detailsKey &&
      existing.count < UPLOAD_MAX_FILES_PER_SESSION
    ) {
      return existing;
    }
    const inflight = this.sessionCreation.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const body = details && Object.keys(details).length > 0 ? { details } : {};
      const s = await apiFetch(`/babies/${babyId}/uploads`, {
        method: "POST",
        body,
        schema: uploadSessionSchema,
      });
      const info: SessionInfo = { id: s.id, babyId, detailsKey, count: 0, finishing: false };
      const prev = this.currentSession.get(babyId);
      this.sessions.set(info.id, info);
      this.currentSession.set(babyId, info.id);
      if (prev) this.maybeFinish(prev);
      return info;
    })().finally(() => this.sessionCreation.delete(key));
    this.sessionCreation.set(key, p);
    return p;
  }

  private async registerGroup(
    babyId: string,
    detailsKey: string,
    details: UploadDetails | undefined,
    group: UploadItem[],
    retried: boolean,
  ): Promise<void> {
    let info: SessionInfo;
    try {
      info = await this.ensureSession(babyId, detailsKey, details);
    } catch (e) {
      const { code, retryable } = errorCodeFor(e);
      for (const g of group) this.fail(g.clientId, code, retryable, e);
      return;
    }
    const room = UPLOAD_MAX_FILES_PER_SESSION - info.count;
    const batch = group.slice(0, Math.max(1, room));
    const files: UploadFileRegisterInput[] = batch.map((g) => {
      const r = this.rt.get(g.clientId) as Runtime;
      const mime = acceptedMime(r.mime);
      return {
        clientId: g.clientId,
        kind: r.kind,
        bytes: r.size,
        ...(r.kind === "video" && r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        ...(r.sha256 ? { clientSha256: r.sha256 } : {}),
        ...(mime ? { mime } : {}),
        ...(r.hint.takenAt ? { takenAt: r.hint.takenAt } : {}),
        ...(r.hint.tzOffsetMinutes !== undefined
          ? { tzOffsetMinutes: r.hint.tzOffsetMinutes }
          : {}),
      };
    });
    try {
      const res = await apiFetch(`/uploads/${info.id}/files`, {
        method: "POST",
        body: { files },
        schema: uploadFilesRegisterResponseSchema,
      });
      info.count += batch.length;
      for (const f of res.files) this.applyRegistered(info, f);
      this.persistResume(babyId);
      this.pumpUploads();
    } catch (e) {
      if (
        !retried &&
        isApiError(e) &&
        (e.code === "upload_session_expired" || e.code === "upload_session_full")
      ) {
        // Stale or full session: drop it and register again in a new one.
        this.currentSession.delete(babyId);
        await this.registerGroup(babyId, detailsKey, details, group, true);
        return;
      }
      const { code, retryable } = errorCodeFor(e);
      for (const g of batch) this.fail(g.clientId, code, retryable, e);
    }
    // Anything that didn't fit stays "registering" and is picked up by the next loop pass.
  }

  private applyRegistered(info: SessionInfo, f: UploadFile) {
    const clientId = f.clientId ?? "";
    const r = this.rt.get(clientId);
    if (!r || !this.item(clientId)) return;
    r.sessionId = info.id;
    r.fileId = f.id;
    r.partSize = f.partSize;
    switch (f.state) {
      case "registered":
        r.parts = f.parts;
        r.partsAt = Date.now();
        this.uploadQueue.push(clientId);
        break;
      case "duplicate":
        this.patch(clientId, { state: "duplicate", error: null, retryable: false });
        this.afterChange(clientId);
        break;
      case "failed": {
        const code = (f.error ?? "unknown") as ItemErrorCode;
        this.fail(clientId, code, code === "storage_error" || code === "upload_incomplete");
        break;
      }
      case "ingested":
        this.patch(clientId, { state: "ingested" });
        this.afterChange(clientId);
        break;
      default:
        this.patch(clientId, { state: "completed" });
        this.schedulePoll();
    }
  }

  // ---- upload -----------------------------------------------------------------------------

  private pumpUploads() {
    while (this.activeUploads < UPLOAD_CONCURRENCY) {
      const id = this.dequeueUpload();
      if (!id) return;
      const it = this.item(id);
      const r = this.rt.get(id);
      if (!it || !r || r.cancelled || it.state === "aborted") continue;
      const sync = it.lane === "sync";
      this.activeUploads++;
      if (sync) this.activeSync++;
      void this.uploadOne(id).finally(() => {
        this.activeUploads--;
        if (sync) this.activeSync--;
        this.pumpUploads();
      });
    }
  }

  /** User items first; a sync item only while fewer than `SYNC_LANE_CONCURRENCY` sync ones run. */
  private dequeueUpload(): string | undefined {
    const laneOf = (id: string) => this.rt.get(id)?.lane ?? "user";
    let at = this.uploadQueue.findIndex((id) => laneOf(id) === "user");
    if (at < 0 && this.activeSync < SYNC_LANE_CONCURRENCY)
      at = this.uploadQueue.length > 0 ? 0 : -1;
    if (at < 0) return undefined;
    return this.uploadQueue.splice(at, 1)[0];
  }

  private async uploadOne(clientId: string): Promise<void> {
    const r = this.rt.get(clientId);
    if (!r?.sessionId || !r.fileId) return;
    const base = `/uploads/${r.sessionId}/files/${r.fileId}`;
    const abort = new AbortController();
    r.abort = abort;
    const size = r.size;
    this.patch(clientId, { state: "uploading", progress: 0, error: null });
    try {
      const urls = new Map<number, string>();
      const done = new Set<number>();
      let urlsAt = 0;
      const loadParts = async () => {
        const res = await apiFetch(`${base}/parts`, { schema: uploadPartsResponseSchema });
        urls.clear();
        for (const p of res.parts) urls.set(p.partNumber, p.url);
        for (const n of res.uploadedPartNumbers) done.add(n);
        urlsAt = Date.now();
      };
      if (r.parts) {
        for (const p of r.parts) urls.set(p.partNumber, p.url);
        urlsAt = r.partsAt;
        r.parts = undefined;
      } else {
        await loadParts();
      }
      const partBytes = (n: number) => Math.min(r.partSize, size - (n - 1) * r.partSize);
      const doneBytes = () => [...done].reduce((sum, n) => sum + partBytes(n), 0);

      for (let attempt = 0; ; attempt++) {
        for (const [partNumber] of [...urls].sort((a, b) => a[0] - b[0])) {
          if (done.has(partNumber)) continue;
          // A multi-GB video on a slow uplink outlives the 1 h signature: refresh proactively.
          if (Date.now() - urlsAt > PART_URLS_MAX_AGE_MS) await loadParts();
          if (done.has(partNumber)) continue;
          const start = (partNumber - 1) * r.partSize;
          const end = partNumber * r.partSize;
          const ref = r.nativeRef;
          const up = this.uploader();
          const single = urls.size === 1 && size <= r.partSize;
          // Native: every part is one ranged background PUT straight from disk (NATIVE.md
          // "Uploads"); a single-part file omits the range. Web: a Blob slice per part.
          const put =
            ref && up.putFile
              ? (url: string, o: PutPartOptions) =>
                  (up.putFile as NonNullable<Uploader["putFile"]>)(url, ref, {
                    ...o,
                    ...(single ? {} : { offset: start, length: partBytes(partNumber) }),
                    ...(r.wifiOnly ? { wifiOnly: true } : {}),
                  })
              : async (url: string, o: PutPartOptions) => {
                  r.file ??= ref ? await readNativeFile(ref) : null;
                  if (!r.file) throw new ApiError(0, "unknown", "missing file");
                  await up.putPart(url, r.file.slice(start, end), o);
                };
          await this.putPart(partNumber, put, urls, loadParts, abort.signal, (loaded) =>
            this.patch(clientId, { progress: Math.min(1, (doneBytes() + loaded) / size) }),
          );
          done.add(partNumber);
          this.patch(clientId, { progress: Math.min(1, doneBytes() / size) });
        }
        this.patch(clientId, { state: "completing", progress: 1 });
        try {
          const file = await apiFetch(`${base}/complete`, {
            method: "POST",
            schema: uploadFileSchema,
          });
          this.applyCompleted(clientId, file);
          return;
        } catch (e) {
          if (isApiError(e, "upload_incomplete") && attempt < 2) {
            done.clear();
            await loadParts();
            this.patch(clientId, { state: "uploading" });
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (r.cancelled || isAbort(e)) return;
      if (isApiError(e) && (e.status === 404 || e.code === "upload_session_expired")) {
        // The old registration is gone (swept or expired): start over as a fresh file.
        r.fileId = null;
        r.sessionId = null;
        r.parts = undefined;
        this.patch(clientId, { state: "registering", progress: 0 });
        this.scheduleRegister();
        return;
      }
      const { code, retryable } = errorCodeFor(e);
      this.fail(clientId, code, retryable, e);
    } finally {
      r.abort = null;
    }
  }

  private async putPart(
    partNumber: number,
    put: (url: string, opts: PutPartOptions) => Promise<void>,
    urls: Map<number, string>,
    refresh: () => Promise<void>,
    signal: AbortSignal,
    onProgress: (loaded: number) => void,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
      const url = urls.get(partNumber);
      if (!url) throw new ApiError(0, "unknown", "missing part url");
      try {
        await put(url, { onProgress, signal });
        return;
      } catch (e) {
        if (isAbort(e)) throw e;
        // A local refusal (no disk, range outside the file) never improves with a retry.
        if (e instanceof PartUploadError && e.reason) throw e;
        lastError = e;
        if (e instanceof PartUploadError && e.status === 403) {
          // Presigned URL expired (after an hour): fetch fresh ones and continue.
          await refresh();
        } else {
          await sleep(500 * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  private applyCompleted(clientId: string, f: UploadFile) {
    if (f.state === "ingested") this.patch(clientId, { state: "ingested", progress: 1 });
    else if (f.state === "duplicate") this.patch(clientId, { state: "duplicate" });
    else if (f.state === "failed") {
      const code = (f.error ?? "unknown") as ItemErrorCode;
      this.fail(clientId, code, false);
      return;
    } else this.patch(clientId, { state: "completed", progress: 1 });
    const it = this.item(clientId);
    if (it) this.emitPhotos(it.babyId);
    this.afterChange(clientId);
    this.schedulePoll();
  }

  // ---- polling ----------------------------------------------------------------------------

  private schedulePoll() {
    if (this.pollTimer) return;
    if (!this.snapshot.some((i) => i.state === "completed")) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, POLL_MS);
  }

  private async poll() {
    const sessionIds = new Set<string>();
    for (const i of this.snapshot) {
      if (i.state !== "completed") continue;
      const sid = this.rt.get(i.clientId)?.sessionId;
      if (sid) sessionIds.add(sid);
    }
    const changedBabies = new Set<string>();
    for (const sid of sessionIds) {
      try {
        const s = await apiFetch(`/uploads/${sid}`, { schema: uploadSessionSchema });
        for (const f of s.files) {
          const entry = [...this.rt.entries()].find(([, r]) => r.fileId === f.id);
          const it = entry ? this.item(entry[0]) : undefined;
          if (!entry || !it || it.state !== "completed") continue;
          if (f.state === "ingested") {
            this.patch(entry[0], { state: "ingested" });
            changedBabies.add(it.babyId);
          } else if (f.state === "duplicate") {
            this.patch(entry[0], { state: "duplicate" });
            changedBabies.add(it.babyId);
          } else if (f.state === "failed") {
            const code = (f.error ?? "unknown") as ItemErrorCode;
            this.fail(entry[0], code, false);
            changedBabies.add(it.babyId);
          }
        }
        this.maybeFinish(sid);
      } catch {
        // transient: the next tick retries
      }
    }
    for (const b of changedBabies) this.emitPhotos(b);
    this.schedulePoll();
  }

  // ---- finish + persistence ---------------------------------------------------------------

  private afterChange(clientId: string) {
    const sid = this.rt.get(clientId)?.sessionId;
    if (sid) this.maybeFinish(sid);
  }

  private persistResume(babyId: string) {
    const sid = this.currentSession.get(babyId);
    if (!sid) return;
    const files: ResumeRecord["files"] = [];
    for (const i of this.snapshot) {
      const r = this.rt.get(i.clientId);
      if (
        i.lane === "user" &&
        i.babyId === babyId &&
        r?.sessionId === sid &&
        r.fileId &&
        r.sha256
      ) {
        files.push({ sha256: r.sha256, size: r.size, fileId: r.fileId });
      }
    }
    writeResume(babyId, { sessionId: sid, files });
  }

  /** Finish the session once every file in it is terminal and none can be retried. */
  private maybeFinish(sessionId: string) {
    const info = this.sessions.get(sessionId);
    if (!info || info.finishing) return;
    const mine = this.snapshot.filter((i) => this.rt.get(i.clientId)?.sessionId === sessionId);
    const open = mine.some((i) => !TERMINAL.has(i.state) || (i.state === "failed" && i.retryable));
    if (open) return;
    // Files of this baby still waiting for a session (e.g. different batch details) keep going.
    info.finishing = true;
    void apiFetch(`/uploads/${sessionId}/finish`, {
      method: "POST",
      schema: uploadSessionSchema,
    })
      .then(() => {
        this.sessions.delete(sessionId);
        if (this.currentSession.get(info.babyId) === sessionId) {
          this.currentSession.delete(info.babyId);
          writeResume(info.babyId, null);
        }
      })
      .catch(() => {
        info.finishing = false;
      });
  }

  // ---- user actions -----------------------------------------------------------------------

  /** Retry one failed file (transport/storage failures only). */
  retry(clientId: string): void {
    const it = this.item(clientId);
    const r = this.rt.get(clientId);
    if (!it || !r || it.state !== "failed" || !it.retryable) return;
    r.cancelled = false;
    this.patch(clientId, { state: "queued", error: null, progress: 0, retryable: false });
    if (r.fileId && r.sessionId) {
      // Server still has the registered file: resume through GET .../parts.
      r.parts = undefined;
      this.uploadQueue.push(clientId);
      this.pumpUploads();
    } else if (r.prepared) {
      this.patch(clientId, { state: "registering" });
      this.scheduleRegister();
    } else {
      this.kickPrep();
    }
  }

  /** Q6: the per-item "Use cellular" switch (native); only before the transfer has started. */
  setWifiOnly(clientId: string, wifiOnly: boolean): void {
    const it = this.item(clientId);
    const r = this.rt.get(clientId);
    if (!it || !r || TERMINAL.has(it.state) || it.state === "completed") return;
    r.wifiOnly = wifiOnly;
    this.patch(clientId, { wifiOnly });
  }

  retryFailed(babyId: string): void {
    for (const i of this.snapshot) {
      if (i.babyId === babyId && i.state === "failed" && i.retryable) this.retry(i.clientId);
    }
  }

  cancel(clientId: string): void {
    const it = this.item(clientId);
    const r = this.rt.get(clientId);
    if (!it || !r || TERMINAL.has(it.state) || it.state === "completed") return;
    r.cancelled = true;
    r.abort?.abort();
    this.patch(clientId, { state: "aborted", progress: 0, error: null, retryable: false });
    if (r.sessionId && r.fileId) {
      void apiFetch(`/uploads/${r.sessionId}/files/${r.fileId}`, { method: "DELETE" })
        .catch(() => undefined)
        .finally(() => this.afterChange(clientId));
    }
  }

  /**
   * Resolves when every listed item is done with: `ingested`, `duplicate`, `failed`, `aborted`,
   * or `completed` (uploaded, waiting for the worker to ingest it). Used by album sync. When
   * `signal` aborts, resolves early with whatever state each item has reached.
   */
  waitForTerminal(clientIds: string[], signal?: AbortSignal): Promise<Map<string, ItemState>> {
    const settled = (s: ItemState) => TERMINAL.has(s) || s === "completed";
    const read = () => {
      const out = new Map<string, ItemState>();
      for (const id of clientIds) out.set(id, this.item(id)?.state ?? "aborted");
      return out;
    };
    return new Promise((resolve) => {
      let off = () => {};
      const finish = () => {
        off();
        signal?.removeEventListener("abort", finish);
        resolve(read());
      };
      const check = () => {
        if ([...read().values()].every(settled)) finish();
      };
      off = this.subscribe(check);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
      else check();
    });
  }

  /** The error code of a failed item (`null` when it has none or is unknown). */
  errorOf(clientId: string): ItemErrorCode | null {
    return this.item(clientId)?.error ?? null;
  }

  /** Drop finished rows of one lane (default `user`: uploaded, duplicate, cancelled, rejected). */
  clearFinished(babyId: string, lane: UploadLane = "user"): void {
    const keep = this.snapshot.filter(
      (i) =>
        i.babyId !== babyId ||
        i.lane !== lane ||
        !(TERMINAL.has(i.state) && !(i.state === "failed" && i.retryable)),
    );
    for (const i of this.snapshot) if (!keep.includes(i)) this.rt.delete(i.clientId);
    this.snapshot = keep;
    for (const l of this.listeners) l();
  }
}

export function summarize(items: readonly UploadItem[], lane?: UploadLane): UploadSummaryCounts {
  let uploaded = 0;
  let failed = 0;
  let duplicates = 0;
  let active = 0;
  const list = lane ? items.filter((i) => i.lane === lane) : items;
  for (const i of list) {
    if (i.state === "completed" || i.state === "ingested") uploaded++;
    else if (i.state === "failed") failed++;
    else if (i.state === "duplicate") duplicates++;
    if (!TERMINAL.has(i.state) && i.state !== "completed") active++;
  }
  return { uploaded, failed, duplicates, total: list.length, active };
}

export const uploadManager = new UploadManager();
