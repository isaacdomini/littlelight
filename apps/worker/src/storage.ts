import { PassThrough, Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { UPLOAD_MAX_FILE_BYTES } from "@tinyglow/shared";

// Worker object storage (docs/plans/step-4.md 2.7, 2.8, D6). The worker uses its bucket-scoped
// MinIO service account (`tinyglow-worker`: get/put/abort + delete incl. object versions) on
// the internal S3_ENDPOINT. Errors surface as `StorageError` carrying the SDK error name only:
// keys are ids, never secrets, but signed URLs and request ids never reach a log line.

export class StorageError extends Error {
  /** SDK error name or HTTP status class, e.g. `NoSuchKey`, `AccessDenied`, `ObjectTooLarge`. */
  readonly code: string;

  constructor(code: string) {
    super(`storage error: ${code}`);
    this.name = "StorageError";
    this.code = code;
  }
}

function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  const code =
    typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) && name !== "Error"
      ? name
      : "error";
  return new StorageError(code);
}

export interface MultipartUploadInfo {
  key: string;
  uploadId: string;
  initiated: Date | null;
}

export interface PutOptions {
  cacheControl?: string;
}

export interface ObjectStorage {
  /** Whole object as a Buffer; `StorageError('ObjectTooLarge')` above `UPLOAD_MAX_FILE_BYTES`. */
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string, opts?: PutOptions): Promise<void>;
  /**
   * Delete every version and delete marker of every object whose key starts with `prefix`
   * (paginated; idempotent: nothing left ⇒ 0). Returns the number of versions removed.
   */
  deleteAllVersions(prefix: string): Promise<number>;
  listMultipartUploads(prefix: string): Promise<MultipartUploadInfo[]>;
  /** Idempotent: `NoSuchUpload` is success. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

/** Options of `putObjectStream` (docs/plans/review-fixes.md 2.3, R1). */
export interface PutStreamOptions {
  /** Multipart part size in bytes (min 5 MiB; default 16 MiB). Memory ≈ `partSize × queueSize`. */
  partSize?: number;
  /** Parts uploaded concurrently (default 2). */
  queueSize?: number;
  /** Aborting stops the upload and aborts the multipart upload (no parts are left behind). */
  signal?: AbortSignal;
}

/**
 * Streaming access (data export, docs/plans/review-fixes.md 2.3). Separate from `ObjectStorage`
 * so the existing in-memory test doubles keep satisfying the buffered interface.
 */
export interface StreamingStorage {
  /**
   * The object's body as a Node stream (never buffered). Resolves once the response headers
   * arrived; `StorageError('NoSuchKey')` etc. when the object cannot be read.
   */
  getObjectStream(key: string): Promise<Readable>;
  /**
   * Upload `body` to `key` with a multipart upload (`@aws-sdk/lib-storage`), streaming: at most
   * `partSize × queueSize` bytes are buffered. Resolves with the bytes written. On failure or
   * abort the multipart upload is aborted (`leavePartsOnError: false`) and a `StorageError` is
   * thrown.
   */
  putObjectStream(
    key: string,
    body: Readable | NodeJS.ReadableStream,
    contentType: string,
    opts?: PutStreamOptions,
  ): Promise<number>;
}

export type WorkerStorage = ObjectStorage & StreamingStorage;

export const STREAM_PART_BYTES = 16 * 1024 * 1024;
export const STREAM_QUEUE_SIZE = 2;

/** Hard cap on version-listing pages per call (1000 keys each) so a bug cannot loop forever. */
const MAX_PAGES = 10_000;

export function createStorage(
  s3: Pick<S3Client, "send">,
  bucket: string,
  maxObjectBytes = UPLOAD_MAX_FILE_BYTES,
): WorkerStorage {
  return {
    async getObjectStream(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = out.Body;
        if (!body) throw new StorageError("EmptyBody");
        if (body instanceof Readable) return body;
        // Non-Node runtimes hand back a web stream; the worker always runs on Node.
        const web = (body as { transformToWebStream?: () => unknown }).transformToWebStream;
        if (typeof web === "function") {
          return Readable.fromWeb(web.call(body) as Parameters<typeof Readable.fromWeb>[0]);
        }
        throw new StorageError("UnsupportedBody");
      } catch (err) {
        throw toStorageError(err);
      }
    },

    async putObjectStream(key, body, contentType, opts = {}) {
      // lib-storage needs the full client (config: endpoint, checksums), not just `send`.
      // lib-storage only streams a core `stream.Readable` (`instanceof`); userland streams such
      // as archiver's (readable-stream) are piped through a core PassThrough (backpressure kept).
      const source = body instanceof Readable ? body : body.pipe(new PassThrough());
      const upload = new Upload({
        client: s3 as S3Client,
        params: { Bucket: bucket, Key: key, Body: source, ContentType: contentType },
        partSize: Math.max(opts.partSize ?? STREAM_PART_BYTES, 5 * 1024 * 1024),
        queueSize: opts.queueSize ?? STREAM_QUEUE_SIZE,
        leavePartsOnError: false,
      });
      let written = 0;
      upload.on("httpUploadProgress", (p) => {
        if (typeof p.loaded === "number") written = p.loaded;
      });
      const onAbort = () => {
        void upload.abort().catch(() => undefined);
        if (source !== body) source.destroy();
      };
      if (opts.signal?.aborted) onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await upload.done();
        return written;
      } catch (err) {
        // lib-storage's own cleanup sends AbortMultipartUpload with the (already aborted) signal,
        // so after an abort the upload would stay open on the server: abort it here, unsignalled.
        if (upload.uploadId) {
          await s3
            .send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: key,
                UploadId: upload.uploadId,
              }),
            )
            .catch(() => undefined);
        }
        throw opts.signal?.aborted ? new StorageError("Aborted") : toStorageError(err);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
    },

    async getObject(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (out.ContentLength !== undefined && out.ContentLength > maxObjectBytes) {
          // Drop the body without reading it.
          (out.Body as { destroy?: () => void } | undefined)?.destroy?.();
          throw new StorageError("ObjectTooLarge");
        }
        if (!out.Body) throw new StorageError("EmptyBody");
        const bytes = await out.Body.transformToByteArray();
        if (bytes.byteLength > maxObjectBytes) throw new StorageError("ObjectTooLarge");
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (err) {
        throw toStorageError(err);
      }
    },

    async putObject(key, body, contentType, opts = {}) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: body.byteLength,
            ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
          }),
        );
      } catch (err) {
        throw toStorageError(err);
      }
    },

    async deleteAllVersions(prefix) {
      if (prefix.length === 0) throw new StorageError("EmptyPrefix");
      let deleted = 0;
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const list = await s3.send(
            new ListObjectVersionsCommand({
              Bucket: bucket,
              Prefix: prefix,
              KeyMarker: keyMarker,
              VersionIdMarker: versionIdMarker,
              MaxKeys: 1000,
            }),
          );
          const objects: ObjectIdentifier[] = [];
          for (const v of [...(list.Versions ?? []), ...(list.DeleteMarkers ?? [])]) {
            if (v.Key?.startsWith(prefix)) {
              objects.push(v.VersionId ? { Key: v.Key, VersionId: v.VersionId } : { Key: v.Key });
            }
          }
          if (objects.length > 0) {
            const res = await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: objects, Quiet: true },
              }),
            );
            const failed = (res.Errors ?? []).filter((e) => e.Code !== "NoSuchVersion");
            if (failed.length > 0) throw new StorageError(failed[0]?.Code ?? "DeleteFailed");
            deleted += objects.length;
          }
          if (!list.IsTruncated) return deleted;
          keyMarker = list.NextKeyMarker;
          versionIdMarker = list.NextVersionIdMarker;
        }
        throw new StorageError("TooManyVersions");
      } catch (err) {
        throw toStorageError(err);
      }
    },

    async listMultipartUploads(prefix) {
      // MinIO (pgsty/minio RELEASE.2026-08-04) only matches `Prefix` on ListMultipartUploads
      // against an exact key; a partial prefix such as `babies/` returns nothing. So list the
      // whole bucket (paginated, bounded by MAX_PAGES) and filter on the prefix client-side.
      // In-progress multipart uploads are few (they are aborted after 48 h), so this stays cheap.
      const out: MultipartUploadInfo[] = [];
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await s3.send(
            new ListMultipartUploadsCommand({
              Bucket: bucket,
              KeyMarker: keyMarker,
              UploadIdMarker: uploadIdMarker,
              MaxUploads: 1000,
            }),
          );
          for (const u of res.Uploads ?? []) {
            if (u.Key?.startsWith(prefix) && u.UploadId) {
              out.push({ key: u.Key, uploadId: u.UploadId, initiated: u.Initiated ?? null });
            }
          }
          if (!res.IsTruncated) return out;
          // A truncated page without a usable marker would re-list the same page forever.
          if (
            !res.NextKeyMarker ||
            (res.NextKeyMarker === keyMarker && res.NextUploadIdMarker === uploadIdMarker)
          ) {
            return out;
          }
          keyMarker = res.NextKeyMarker;
          uploadIdMarker = res.NextUploadIdMarker;
        }
        return out;
      } catch (err) {
        throw toStorageError(err);
      }
    },

    async abortMultipartUpload(key, uploadId) {
      try {
        await s3.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        );
      } catch (err) {
        const e = toStorageError(err);
        if (e.code === "NoSuchUpload" || e.code === "NotFound") return;
        throw e;
      }
    },
  };
}
