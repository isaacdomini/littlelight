import { S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { ApiConfig } from "../config";

/** The slice of `S3Client` the API uses; tests pass a stub with the same shape. */
export type StorageClient = Pick<S3Client, "send" | "destroy">;

declare module "fastify" {
  interface FastifyInstance {
    s3: StorageClient;
  }
}

/**
 * Server-side S3 client for MinIO. Uses the internal `S3_ENDPOINT` (e.g. `http://storage:9000`);
 * `S3_PUBLIC_ENDPOINT` is only for signing client-facing URLs (`storage/sign.ts`) and never used
 * here. Checksums only when an operation requires them: browser-uploaded parts carry none, so a
 * default checksum algorithm on CreateMultipartUpload/Complete would make completion fail.
 */
export function createS3Client(
  config: Pick<
    ApiConfig,
    "S3_ENDPOINT" | "S3_REGION" | "S3_ACCESS_KEY" | "S3_SECRET_KEY" | "S3_FORCE_PATH_STYLE"
  >,
): S3Client {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Decorate the root instance with `app.s3`; destroys the client on `app.close()`. */
export function registerStorage(app: FastifyInstance, s3: StorageClient): void {
  app.decorate("s3", s3);
  app.addHook("onClose", async () => {
    s3.destroy();
  });
}
