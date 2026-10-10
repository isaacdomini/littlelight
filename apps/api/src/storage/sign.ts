import { GetObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SIGNED_URL_TTL_SEC } from "@tinyglow/shared";
import type { ApiConfig } from "../config";

// Client-facing signed URLs (docs/plans/step-4.md 2.1, 2.10; PRD "Privacy and child safety":
// signed URLs valid <= 1 hour and scoped to one object). The signer is its own S3 client on
// `S3_PUBLIC_ENDPOINT` and never sends a request: SigV4 signs the Host header, so the URL must
// name the host the browser will hit (localhost:9000 in dev, `files.` through Cloudflare
// Tunnel, which forwards the original Host). Server-side calls use `app.s3` on `S3_ENDPOINT`.
//
// Rules enforced by callers, documented here because this is the only signing path:
// - Every URL is one presigned `GetObject` or `UploadPart` for exactly one key.
// - TTL is capped at `SIGNED_URL_TTL_SEC` (3600 s) whatever the caller asks for.
// - Users only ever get `thumb`/`display` derivative URLs; `analysis` is never signed; originals
//   only through the admin route `GET /photos/:id/original`.
// - Signed URLs are capability tokens: never log them, never persist them.
// - Step 8 (docs/plans/step-8.md 2.9, D6): every presigned GET carries
//   `response-cache-control: private, max-age=<ttl>` (parents' and viewers' alike), so MinIO
//   answers with `Cache-Control: private` and no shared cache (Cloudflare in front of `files.`)
//   ever stores a photo; a revoked share link leaves nothing to purge. A caller override must
//   still be `private` or `no-store`. Viewer media URLs use `shareMediaTtlSec` (≤
//   `SHARE_MEDIA_URL_TTL_SEC` and ≤ the link's expiry).

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface SignGetOptions {
  /** Seconds; clamped to 1..`SIGNED_URL_TTL_SEC`. Default `SIGNED_URL_TTL_SEC`. */
  ttlSec?: number;
  /** `response-content-type` override (the original's sniffed mime). */
  contentType?: string;
  /** `response-content-disposition` override (e.g. `attachment; filename="…"`). */
  contentDisposition?: string;
  /**
   * `response-cache-control` override. Default `private, max-age=<clamped ttl>`. Must contain the
   * `private` or `no-store` directive (a shared cache may never store a signed photo response,
   * D6); anything else, or a value with control characters, throws `RangeError`.
   */
  cacheControl?: string;
}

export interface UrlSigner {
  /** Presigned `GetObject` for one key. */
  signGet(key: string, opts?: SignGetOptions): Promise<SignedUrl>;
  /** Presigned `UploadPart` (plain `PUT`, no custom headers) for one part of one multipart upload. */
  signUploadPart(key: string, uploadId: string, partNumber: number): Promise<SignedUrl>;
}

declare module "fastify" {
  interface FastifyInstance {
    signer: UrlSigner;
  }
}

/** Clamp a requested TTL to 1..`SIGNED_URL_TTL_SEC` (non-finite ⇒ the maximum). Exported for tests. */
export function clampTtl(ttlSec: number | undefined): number {
  if (ttlSec === undefined || !Number.isFinite(ttlSec)) return SIGNED_URL_TTL_SEC;
  return Math.min(SIGNED_URL_TTL_SEC, Math.max(1, Math.floor(ttlSec)));
}

/** `Cache-Control` of a signed GET's response when the caller does not override it. */
export function defaultCacheControl(ttlSec: number): string {
  return `private, max-age=${ttlSec}`;
}

// Bare directive only: `private="field"` would let a shared cache store everything else.
const NO_SHARED_CACHE = /(^|,)\s*(private|no-store)\s*(,|$)/i;
// Visible ASCII and spaces only: the value becomes a response header.
const HEADER_VALUE = /^[\x20-\x7e]+$/;

/** Validate a caller's `cacheControl` override (see `SignGetOptions.cacheControl`). Exported for tests. */
export function assertPrivateCacheControl(value: string): string {
  if (!HEADER_VALUE.test(value) || !NO_SHARED_CACHE.test(value)) {
    throw new RangeError("cacheControl must be private or no-store");
  }
  return value;
}

/**
 * Lifetime of a viewer media URL (step-8 plan 2.6): `SHARE_MEDIA_URL_TTL_SEC` (default 300 s),
 * never past the share link's expiry, at least 1 s (the session check already refused an expired
 * link). Pass the result as `ttlSec`; the default cache header then says `private, max-age=<it>`.
 */
export function shareMediaTtlSec(
  maxTtlSec: number,
  linkExpiresAt: Date,
  nowMs: number = Date.now(),
): number {
  const untilExpiry = Math.floor((linkExpiresAt.getTime() - nowMs) / 1000);
  return clampTtl(Math.min(maxTtlSec, untilExpiry));
}

type SignerConfig = Pick<
  ApiConfig,
  | "S3_PUBLIC_ENDPOINT"
  | "S3_REGION"
  | "S3_ACCESS_KEY"
  | "S3_SECRET_KEY"
  | "S3_FORCE_PATH_STYLE"
  | "S3_BUCKET"
>;

/**
 * Create the signer on `S3_PUBLIC_ENDPOINT`. `requestChecksumCalculation: WHEN_REQUIRED` keeps
 * the SDK from baking a checksum of an empty body (`x-amz-checksum-crc32`) into presigned
 * `UploadPart` URLs, which would make every real part `PUT` fail its checksum.
 */
export function createUrlSigner(config: SignerConfig, now: () => number = Date.now): UrlSigner {
  const client = new S3Client({
    endpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const bucket = config.S3_BUCKET;

  return {
    async signGet(key, opts = {}) {
      const ttl = clampTtl(opts.ttlSec);
      const cacheControl =
        opts.cacheControl === undefined
          ? defaultCacheControl(ttl)
          : assertPrivateCacheControl(opts.cacheControl);
      const issuedAt = now();
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
          ...(opts.contentDisposition
            ? { ResponseContentDisposition: opts.contentDisposition }
            : {}),
          ResponseCacheControl: cacheControl,
        }),
        { expiresIn: ttl, signingDate: new Date(issuedAt) },
      );
      return { url, expiresAt: new Date(issuedAt + ttl * 1000) };
    },

    async signUploadPart(key, uploadId, partNumber) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new RangeError("partNumber must be an integer in 1..10000");
      }
      const ttl = SIGNED_URL_TTL_SEC;
      const issuedAt = now();
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttl, signingDate: new Date(issuedAt) },
      );
      return { url, expiresAt: new Date(issuedAt + ttl * 1000) };
    },
  };
}
