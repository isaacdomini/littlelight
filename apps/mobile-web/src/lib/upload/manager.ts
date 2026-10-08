import {
  UPLOAD_CONCURRENCY,
  UPLOAD_MAX_FILES_PER_REQUEST,
  UPLOAD_MAX_FILES_PER_SESSION,
  type UploadDetails,
  type UploadFile,
  type UploadFileRegister,
  uploadFileSchema,
  uploadFilesRegisterResponseSchema,
  uploadPartsResponseSchema,
  uploadSessionSchema,
} from "@littlelight/shared";
import { getUploader, PartUploadError, type Uploader } from "../../platform/uploader";
import { ApiError, apiFetch, isApiError } from "../api";
import { readCaptureHint } from "./exif";
import { sha256Hex } from "./hash";
import { acceptedMime, validateFile } from "./validate";

// Upload orchestration (docs/plans/step-4.md 2.12). Plain class + useSyncExternalStore.
// Pipeline: prep (SHA-256 + EXIF hint, one file at a time) -> register (batched, <=100) ->
// upload (UPLOAD_CONCURRENCY files in flight, parts of one file sequential) -> complete (the API
// lists the parts and completes; the client never needs ETags) -> poll until the worker ingests.
// Files that fail the client-side type/size gate are shown as failed and never sent to the API.

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

/** `unsupported` / `too_large` are client-side; the rest mirror `uploadFileError` + transport. */
export type ItemErrorCode =
  | "unsupported"
  | "too_large"
  | "unsupported_media_type"
  | "file_too_large"
  | "decode_failed"
  | "free_tier_limit"
  | "rejected"
  | "expired"
  | "storage_error"
  | "upload_incomplete"
  | "network"
  | "unknown";

export interface UploadItem {
  clientId: string;
  babyId: string;
  name: string;
  size: number;
  state: ItemState;
  /** 0..1 while uploading. */
  progress: number;
  error: ItemErrorCode | null;
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

interface Runtime {
  file: File;
  detailsKey: string;
  details: UploadDetails | undefined;
  sha256: string | null;
  hint: { takenAt?: string; tzOffsetMinutes?: number };
  prepared: boolean;
  sessionId: string | null;
  fileId: string | null;
  partSize: number;
  /** Fresh part URLs from the register response; undefined means "ask GET .../parts". */
  parts: { partNumber: number; url: string }[] | undefined;
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function errorCodeFor(e: unknown): { code: ItemErrorCode; retryable: boolean } {
  if (e instanceof ApiError) {
    if (e.code === "free_tier_limit") return { code: "free_tier_limit", retryable: false };
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

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
}

export interface UploadManagerOptions {
  uploader?: () => Uploader;
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
    this.snapshot = this.snapshot.map((i) => (i.clientId === clientId ? { ...i, ...change } : i));
    for (const l of this.listeners) l();
  }

  private item(clientId: string): UploadItem | undefined {
    return this.snapshot.find((i) => i.clientId === clientId);
  }

  private fail(clientId: string, code: ItemErrorCode, retryable: boolean) {
    this.patch(clientId, { state: "failed", error: code, retryable, progress: 0 });
    const r = this.rt.get(clientId);
    if (r) r.abort = null;
    this.afterChange(clientId);
  }

  // ---- adding files ----------------------------------------------------------------------

  /** Queue files for a baby. Rejected files appear as failed and are never sent to the API. */
  add(babyId: string, files: File[], details?: UploadDetails): void {
    const detailsKey = JSON.stringify(details ?? {});
    const added: UploadItem[] = [];
    for (const file of files) {
      const clientId = `${++this.counter}-${sanitizeName(file.name)}`;
      const reason = validateFile(file);
      const item: UploadItem = {
        clientId,
        babyId,
        name: file.name,
        size: file.size,
        state: reason ? "failed" : "queued",
        progress: 0,
        error: reason,
        retryable: false,
      };
      added.push(item);
      if (!reason) {
        this.rt.set(clientId, this.newRuntime(file, detailsKey, details));
      }
    }
    this.snapshot = [...this.snapshot, ...added];
    for (const l of this.listeners) l();
    this.kickPrep();
  }

  private newRuntime(file: File, detailsKey: string, details: UploadDetails | undefined): Runtime {
    return {
      file,
      detailsKey,
      details,
      sha256: null,
      hint: {},
      prepared: false,
      sessionId: null,
      fileId: null,
      partSize: 0,
      parts: undefined,
      abort: null,
      cancelled: false,
    };
  }

  /**
   * After a reload: match re-picked files to the stored session by SHA-256 + size, skip the
   * ones the server already has, resume the registered ones through `GET .../parts`, and upload
   * the rest normally.
   */
  async resume(babyId: string, files: File[], details?: UploadDetails): Promise<void> {
    const stored = readResume(babyId);
    if (!stored) {
      this.add(babyId, files, details);
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
      this.add(babyId, files, details);
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
      const reason = validateFile(file);
      if (reason) {
        rest.push(file);
        continue;
      }
      const sha = await sha256Hex(file);
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
      const clientId = `${++this.counter}-${sanitizeName(file.name)}`;
      const r = this.newRuntime(file, detailsKey, session.details);
      r.sha256 = sha;
      r.prepared = true;
      r.sessionId = session.id;
      r.fileId = sf.id;
      r.partSize = sf.partSize;
      this.rt.set(clientId, r);
      const state: ItemState = sf.state === "registered" ? "queued" : (sf.state as ItemState);
      added.push({
        clientId,
        babyId,
        name: file.name,
        size: file.size,
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
    if (rest.length > 0) this.add(babyId, rest, details);
    else this.maybeFinish(session.id);
  }

  // ---- prep: hash + EXIF hint (one file at a time) ----------------------------------------

  private kickPrep() {
    if (this.prepRunning) return;
    this.prepRunning = true;
    void (async () => {
      try {
        for (;;) {
          const next = this.snapshot.find(
            (i) => i.state === "queued" && this.rt.get(i.clientId)?.prepared === false,
          );
          if (!next) break;
          const r = this.rt.get(next.clientId);
          if (!r) break;
          this.patch(next.clientId, { state: "hashing" });
          const [sha, hint] = await Promise.all([sha256Hex(r.file), readCaptureHint(r.file)]);
          r.sha256 = sha;
          r.hint = hint;
          r.prepared = true;
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
      for (const g of group) this.fail(g.clientId, code, retryable);
      return;
    }
    const room = UPLOAD_MAX_FILES_PER_SESSION - info.count;
    const batch = group.slice(0, Math.max(1, room));
    const files: UploadFileRegister[] = batch.map((g) => {
      const r = this.rt.get(g.clientId) as Runtime;
      const mime = acceptedMime(r.file.type);
      return {
        clientId: g.clientId,
        bytes: r.file.size,
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
      for (const g of batch) this.fail(g.clientId, code, retryable);
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
      const id = this.uploadQueue.shift();
      if (!id) return;
      const it = this.item(id);
      const r = this.rt.get(id);
      if (!it || !r || r.cancelled || it.state === "aborted") continue;
      this.activeUploads++;
      void this.uploadOne(id).finally(() => {
        this.activeUploads--;
        this.pumpUploads();
      });
    }
  }

  private async uploadOne(clientId: string): Promise<void> {
    const r = this.rt.get(clientId);
    if (!r?.sessionId || !r.fileId) return;
    const base = `/uploads/${r.sessionId}/files/${r.fileId}`;
    const abort = new AbortController();
    r.abort = abort;
    const size = r.file.size;
    this.patch(clientId, { state: "uploading", progress: 0, error: null });
    try {
      const urls = new Map<number, string>();
      const done = new Set<number>();
      const loadParts = async () => {
        const res = await apiFetch(`${base}/parts`, { schema: uploadPartsResponseSchema });
        urls.clear();
        for (const p of res.parts) urls.set(p.partNumber, p.url);
        for (const n of res.uploadedPartNumbers) done.add(n);
      };
      if (r.parts) {
        for (const p of r.parts) urls.set(p.partNumber, p.url);
        r.parts = undefined;
      } else {
        await loadParts();
      }
      const partBytes = (n: number) => Math.min(r.partSize, size - (n - 1) * r.partSize);
      const doneBytes = () => [...done].reduce((sum, n) => sum + partBytes(n), 0);

      for (let attempt = 0; ; attempt++) {
        for (const [partNumber] of [...urls].sort((a, b) => a[0] - b[0])) {
          if (done.has(partNumber)) continue;
          const blob = r.file.slice((partNumber - 1) * r.partSize, partNumber * r.partSize);
          await this.putPart(partNumber, blob, urls, loadParts, abort.signal, (loaded) =>
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
      this.fail(clientId, code, retryable);
    } finally {
      r.abort = null;
    }
  }

  private async putPart(
    partNumber: number,
    blob: Blob,
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
        await this.uploader().putPart(url, blob, { onProgress, signal });
        return;
      } catch (e) {
        if (isAbort(e)) throw e;
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
      if (i.babyId === babyId && r?.sessionId === sid && r.fileId && r.sha256) {
        files.push({ sha256: r.sha256, size: r.file.size, fileId: r.fileId });
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

  /** Drop finished rows (uploaded, duplicate, cancelled, rejected) from the list. */
  clearFinished(babyId: string): void {
    const keep = this.snapshot.filter(
      (i) =>
        i.babyId !== babyId || !(TERMINAL.has(i.state) && !(i.state === "failed" && i.retryable)),
    );
    for (const i of this.snapshot) if (!keep.includes(i)) this.rt.delete(i.clientId);
    this.snapshot = keep;
    for (const l of this.listeners) l();
  }
}

export function summarize(items: readonly UploadItem[]): UploadSummaryCounts {
  let uploaded = 0;
  let failed = 0;
  let duplicates = 0;
  let active = 0;
  for (const i of items) {
    if (i.state === "completed" || i.state === "ingested") uploaded++;
    else if (i.state === "failed") failed++;
    else if (i.state === "duplicate") duplicates++;
    if (!TERMINAL.has(i.state) && i.state !== "completed") active++;
  }
  return { uploaded, failed, duplicates, total: items.length, active };
}

export const uploadManager = new UploadManager();
