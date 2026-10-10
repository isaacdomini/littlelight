import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { PhotoMetaRow } from "../export/content";
import {
  BABY_SQL,
  CANCEL_QUEUED_EXPORT_SQL,
  CLAIM_EXPORT_SQL,
  MANIFEST_PAGE_SQL,
  MARK_FAILED_SQL,
  MARK_READY_SQL,
  MEASUREMENTS_PAGE_SQL,
  MEMBERS_SQL,
  MILESTONES_SQL,
  PHOTO_ROWS_SQL,
  PHOTO_ROWS_WITH_GPS_SQL,
  PROGRESS_SQL,
  REQUESTER_EMAIL_SQL,
  REQUESTER_IS_ADMIN_SQL,
} from "../export/sql";
import { StorageError } from "../storage";
import { type Handler, scriptedPool } from "./stubs";

// Doubles for the data.export tests (apps/worker/src/export/*.test.ts). Test-only.

const execFileP = promisify(execFile);

export const EXPORT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const BABY_ID = "11111111-1111-4111-8111-111111111111";
export const STORAGE_KEY = `babies/${BABY_ID}/exports/${EXPORT_ID}.zip`;

/** A deterministic original of `size` bytes, as a Buffer (small) per photo index. */
export function fixtureBytes(index: number, size = 4096): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + index * 17) & 0xff;
  return out;
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface ExportStorageStub {
  /** Every call in order, e.g. `getObjectStream:<key>`, `put:<key>`, `delete:<prefix>`. */
  calls: string[];
  objects: Map<string, () => Readable>;
  /** Bytes of the last uploaded ZIP, written to `zipPath` when `keepZip` is set. */
  zipPath: string | null;
  uploadedBytes: number;
  failGet: Set<string>;
  failPut: boolean;
  /** Called with each chunk length the sink receives (memory test). */
  onChunk?: (len: number) => void;
  getObject: (key: string) => Promise<Buffer>;
  getObjectStream: (key: string) => Promise<Readable>;
  putObjectStream: (
    key: string,
    body: Readable | NodeJS.ReadableStream,
    contentType: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<number>;
  deleteAllVersions: (prefix: string) => Promise<number>;
  dispose: () => Promise<void>;
}

/**
 * A streaming storage double. `getObject` always throws (the export must stream); the uploaded
 * ZIP is drained to a temp file when `keepZip`, else only counted.
 */
export async function exportStorageStub(
  opts: { keepZip?: boolean } = {},
): Promise<ExportStorageStub> {
  const dir = await mkdtemp(join(tmpdir(), "ll-export-"));
  const stub: ExportStorageStub = {
    calls: [],
    objects: new Map(),
    zipPath: null,
    uploadedBytes: 0,
    failGet: new Set(),
    failPut: false,
    async getObject(key) {
      stub.calls.push(`getObject:${key}`);
      throw new Error("export must not buffer originals (getObject called)");
    },
    async getObjectStream(key) {
      stub.calls.push(`getObjectStream:${key}`);
      if (stub.failGet.has(key)) throw new StorageError("NoSuchKey");
      const make = stub.objects.get(key);
      if (!make) throw new StorageError("NoSuchKey");
      return make();
    },
    async putObjectStream(key, body, _contentType, o = {}) {
      stub.calls.push(`put:${key}`);
      if (stub.failPut) {
        (body as Readable).resume();
        throw new StorageError("Unavailable");
      }
      let n = 0;
      const file = opts.keepZip ? createWriteStream(join(dir, "export.zip")) : null;
      const counter = new Writable({
        write(chunk: Buffer, _enc, cb) {
          n += chunk.length;
          stub.onChunk?.(chunk.length);
          if (file) file.write(chunk, cb);
          else cb();
        },
        final(cb) {
          if (file) file.end(cb);
          else cb();
        },
      });
      const aborted = new Promise<never>((_, reject) => {
        o.signal?.addEventListener("abort", () => reject(new StorageError("Aborted")), {
          once: true,
        });
      });
      aborted.catch(() => undefined);
      await Promise.race([pipeline(body as Readable, counter), aborted]);
      stub.uploadedBytes = n;
      if (opts.keepZip) stub.zipPath = join(dir, "export.zip");
      return n;
    },
    async deleteAllVersions(prefix) {
      stub.calls.push(`delete:${prefix}`);
      return 1;
    },
    async dispose() {
      await rm(dir, { recursive: true, force: true });
    },
  };
  return stub;
}

export interface ZipEntryInfo {
  name: string;
  /** `stor` (stored) or `defN` (deflated), from `zipinfo`. */
  method: string;
  size: number;
}

/** Lists a ZIP with the system `zipinfo` (present on macOS and Ubuntu runners). */
export async function listZip(zipPath: string): Promise<ZipEntryInfo[]> {
  const { stdout } = await execFileP("zipinfo", [zipPath], { maxBuffer: 64 * 1024 * 1024 });
  const entries: ZipEntryInfo[] = [];
  for (const line of stdout.split("\n")) {
    // -rw-a--     4.5 fat     4096 bX stor 26-Oct-10 10:00 originals/x.jpg
    const m = /^[-dl]\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m) entries.push({ size: Number(m[1]), method: (m[2] ?? "").slice(0, 4), name: m[3] ?? "" });
  }
  return entries;
}

/** One entry's bytes through the system `unzip -p`. */
export async function readZipEntry(zipPath: string, name: string): Promise<Buffer> {
  const { stdout } = await execFileP("unzip", ["-p", zipPath, name], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export async function zipTestsOk(zipPath: string): Promise<boolean> {
  try {
    await execFileP("unzip", ["-tq", zipPath]);
    return true;
  } catch {
    return false;
  }
}

export const readText = async (p: string) => readFile(p, "utf8");

export interface FixturePhoto {
  id: string;
  mime?: string;
  fileDate?: string;
  bytes?: number;
  /** Row overrides of the metadata statements. */
  meta?: Partial<PhotoMetaRow>;
  lat?: number | null;
  lng?: number | null;
}

export const photoId = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;

export function metaRow(p: FixturePhoto): PhotoMetaRow {
  return {
    id: p.id,
    taken_at: new Date("2026-06-14T10:00:00Z"),
    taken_at_estimated: false,
    tz_offset_minutes: -420,
    age_days: 105,
    status: "ready",
    approval: "approved",
    is_sensitive: false,
    uploaded_by_name: "Mom",
    width: 800,
    height: 600,
    bytes: String(p.bytes ?? 4096),
    mime: p.mime ?? "image/jpeg",
    sha256: "ab".repeat(32),
    milestone_id: null,
    milestone_name: null,
    milestone_category: null,
    people: [],
    note: null,
    location_label: null,
    exif_taken_at: null,
    place_label: null,
    camera_make: null,
    camera_model: null,
    orientation: null,
    ai_model: null,
    ai_prompt_version: null,
    ai_schema_version: null,
    ai_description: null,
    ai_sensitive_flags: [],
    ai_analyzed_at: null,
    ai_overrides: null,
    ...p.meta,
  };
}

export interface ScriptOptions {
  photos: FixturePhoto[];
  includeLocation?: boolean;
  /** Result of `export_requester_is_admin` (default true). */
  isAdmin?: boolean;
  /** `export_requester_email` (default a placeholder address). */
  email?: string | null;
  /** The claim returns no row (not queued / already taken). */
  noClaim?: boolean;
  /** Statements to override or add. */
  extra?: Record<string, Handler>;
  pageSize?: number;
  babyName?: string;
}

/** A scripted pipeline pool answering the export's statements from `photos`. */
export function exportPool(o: ScriptOptions) {
  const byId = new Map(o.photos.map((p) => [p.id, p]));
  const handlers: Record<string, Handler> = {
    [CLAIM_EXPORT_SQL]: () =>
      o.noClaim
        ? { rows: [] }
        : {
            rows: [
              {
                id: EXPORT_ID,
                baby_id: BABY_ID,
                include_location: o.includeLocation ?? false,
                storage_key: STORAGE_KEY,
                expires_at: new Date("2026-10-17T10:00:00Z"),
              },
            ],
          },
    [CANCEL_QUEUED_EXPORT_SQL]: () => ({ rowCount: 0 }),
    [REQUESTER_IS_ADMIN_SQL]: () => ({ rows: [{ ok: o.isAdmin ?? true }] }),
    [BABY_SQL]: () => ({
      rows: [
        {
          id: BABY_ID,
          name: o.babyName ?? "Maya",
          nickname: null,
          birth_date: "2026-01-30",
          birth_date_is_due_date: false,
          birth_weight_g: 3400,
          birth_length_mm: 500,
          home_label: null,
        },
      ],
    }),
    [MEMBERS_SQL]: () => ({
      rows: [{ display_name: "Mom", relationship_label: "mother", role: "admin" }],
    }),
    [MANIFEST_PAGE_SQL]: (params) => {
      const after = String(params[2]);
      const limit = Number(params[3]);
      const ids = o.photos.map((p) => p.id);
      const start = after === "00000000-0000-0000-0000-000000000000" ? 0 : ids.indexOf(after) + 1;
      return {
        rows: o.photos.slice(start, start + limit).map((p) => ({
          id: p.id,
          storage_key_original: `babies/${BABY_ID}/originals/${p.id}`,
          mime: p.mime ?? "image/jpeg",
          bytes: String(p.bytes ?? 4096),
          entry_date: new Date("2026-06-14T10:00:00Z"),
          file_date: p.fileDate ?? "2026-06-14",
          sort_key: `2026-06-14 10:00:00.${String(ids.indexOf(p.id)).padStart(6, "0")}+00`,
        })),
      };
    },
    [PHOTO_ROWS_SQL]: (params) => ({
      rows: (params[0] as string[]).map((id) => metaRow(byId.get(id) as FixturePhoto)),
    }),
    [PHOTO_ROWS_WITH_GPS_SQL]: (params) => ({
      rows: (params[0] as string[]).map((id) => {
        const p = byId.get(id) as FixturePhoto;
        return { ...metaRow(p), gps_lat: p.lat ?? null, gps_lng: p.lng ?? null };
      }),
    }),
    [MILESTONES_SQL]: () => ({ rows: [] }),
    [MEASUREMENTS_PAGE_SQL]: () => ({ rows: [] }),
    [MARK_FAILED_SQL]: () => ({ rowCount: 1 }),
    [PROGRESS_SQL]: () => ({ rows: [{ live: true }] }),
    [MARK_READY_SQL]: () => ({ rows: [{ expires_at: new Date("2026-10-17T10:00:00Z") }] }),
    [REQUESTER_EMAIL_SQL]: () => ({
      rows: [{ email: o.email === undefined ? "mom@example.test" : o.email }],
    }),
    ...o.extra,
  };
  return scriptedPool(handlers);
}

/** Readable of `chunks` pieces of `chunkSize` zero bytes (shared buffer: no per-chunk allocation). */
export function zeroStream(totalBytes: number, chunkSize = 64 * 1024): Readable {
  const shared = Buffer.alloc(chunkSize);
  let left = totalBytes;
  return new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const n = Math.min(left, chunkSize);
      left -= n;
      this.push(n === chunkSize ? shared : shared.subarray(0, n));
    },
  });
}
