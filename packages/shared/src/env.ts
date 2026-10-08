import { z } from "zod";

// Environment schemas shared by api, worker and db tooling (docs/plans/step-1.md 2.10, 2.5).
// Apps compose these in their own config modules and fail fast on invalid env, printing field
// names only (never values: several of these are secrets or contain credentials).

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
});
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/**
 * S3-compatible object storage (MinIO in every environment).
 * - `S3_ENDPOINT`: internal endpoint for server-side calls (e.g. `http://storage:9000`).
 * - `S3_PUBLIC_ENDPOINT`: endpoint used only when signing URLs handed to clients.
 */
export const s3EnvSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  /** Env strings "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off"; MinIO needs path-style. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
});
export type S3Env = z.infer<typeof s3EnvSchema>;

/**
 * GoTrue signs JWTs with `GOTRUE_JWT_SECRET`; api/worker verify with `JWT_SECRET`. When both are
 * present they must be identical, otherwise every token would fail verification at runtime, so
 * the mismatch is rejected at boot.
 */
export const jwtEnvSchema = z
  .object({
    JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    GOTRUE_JWT_SECRET: z.string().min(1).optional(),
  })
  .refine(
    (env) => env.GOTRUE_JWT_SECRET === undefined || env.GOTRUE_JWT_SECRET === env.JWT_SECRET,
    {
      path: ["GOTRUE_JWT_SECRET"],
      message: "must equal JWT_SECRET",
    },
  );
export type JwtEnv = z.infer<typeof jwtEnvSchema>;

export const logEnvSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});
export type LogEnv = z.infer<typeof logEnvSchema>;
