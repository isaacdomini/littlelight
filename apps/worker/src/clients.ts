import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import type { WorkerConfig } from "./config";

/** pg pool for worker-owned queries (pg-boss manages its own pool). */
export function createPool(config: Pick<WorkerConfig, "DATABASE_URL">, applicationName: string) {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: applicationName,
  });
}

/** Server-side S3 client on the internal `S3_ENDPOINT` (never `S3_PUBLIC_ENDPOINT`). */
export function createS3Client(
  config: Pick<
    WorkerConfig,
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
  });
}

/** Short, safe error category (errno, SQLSTATE, SDK error name); never a raw message. */
export function errorCategory(err: unknown): string {
  if (typeof err !== "object" || err === null) return "error";
  const { code, name } = err as { code?: unknown; name?: unknown };
  for (const candidate of [code, name]) {
    if (
      typeof candidate === "string" &&
      /^[A-Za-z0-9_]{1,64}$/.test(candidate) &&
      candidate !== "Error"
    ) {
      return candidate;
    }
  }
  return "error";
}
