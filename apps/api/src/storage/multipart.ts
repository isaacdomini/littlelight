import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import type { StorageClient } from "../plugins/storage";

// Server-side multipart calls on `app.s3` (`S3_ENDPOINT`, the api's bucket-scoped MinIO account:
// put/get/abort/list parts, no delete; docs/plans/step-4.md 2.1, 2.11). Photo bytes never pass
// through the API: the browser PUTs parts to presigned URLs (`storage/sign.ts`) and the API only
// creates, lists, completes and aborts. Errors are rethrown as-is; callers log `errorCategory`
// only (SDK messages can contain keys and endpoints).

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

/** Error names/codes S3 and MinIO use for a multipart upload that no longer exists. */
export function isNoSuchUpload(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, Code } = err as { name?: unknown; Code?: unknown };
  return name === "NoSuchUpload" || Code === "NoSuchUpload";
}

/**
 * HeadObject on a missing key: `NotFound` / 404 (the api account has `s3:ListBucket`, so MinIO
 * answers 404 rather than 403). A 403 is a real permission problem and is rethrown.
 */
export function isMissingObject(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

/**
 * Whether `key` exists in `bucket` (HeadObject). Missing ⇒ false; any other storage error is
 * rethrown (callers log `errorCategory` only).
 */
export async function objectExists(
  s3: StorageClient,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isMissingObject(err)) return false;
    throw err;
  }
}

/** Errors on Complete that mean "the parts as uploaded are not acceptable": re-upload them. */
export function isInvalidParts(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name } = err as { name?: unknown };
  return name === "InvalidPart" || name === "InvalidPartOrder" || name === "EntityTooSmall";
}

export class MultipartStorage {
  constructor(
    private readonly s3: StorageClient,
    private readonly bucket: string,
  ) {}

  /** Start a multipart upload for `key`; returns the upload id. */
  async create(key: string): Promise<string> {
    const out = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!out.UploadId) throw new Error("CreateMultipartUpload returned no UploadId");
    return out.UploadId;
  }

  /** Every uploaded part (paginated), ascending by part number. */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 20; page++) {
      const out = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MaxParts: 1000,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      );
      for (const p of out.Parts ?? []) {
        if (typeof p.PartNumber === "number" && typeof p.ETag === "string") {
          parts.push({ partNumber: p.PartNumber, size: p.Size ?? 0, etag: p.ETag });
        }
      }
      if (!out.IsTruncated || out.NextPartNumberMarker === undefined) break;
      marker = String(out.NextPartNumberMarker);
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  /** Complete with the given parts (ETags from `listParts`, ascending). */
  async complete(
    key: string,
    uploadId: string,
    parts: readonly Pick<UploadedPart, "partNumber" | "etag">[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  /** Abort; a multipart upload that is already gone counts as aborted. */
  async abort(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if (!isNoSuchUpload(err)) throw err;
    }
  }

  /** Size of the completed object, or null when it does not exist. */
  async objectSize(key: string): Promise<number | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return typeof out.ContentLength === "number" ? out.ContentLength : null;
    } catch (err) {
      if (isMissingObject(err)) return null;
      throw err;
    }
  }
}
