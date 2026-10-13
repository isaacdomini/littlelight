import { z } from "zod";
import { APP_UPDATE_VERSION_RE } from "../app-update";

// Live-update manifest endpoint (docs/plans/step-14.md 2.3, 2.6, D7, D9).
// `GET /app-update/manifest?platform&native&current` (browser path `/api/app-update/manifest`):
// public, no auth, `Cache-Control: no-store`. Callers without `X-Tinyglow-Client: native` get
// `{ update: null, reason: "disabled" }`. A bad query is the existing 400 `validation_failed`;
// every other outcome is a 200. The query carries no device identifier; the api logs
// `{ outcome, platform }` only (never `native`, `current`, the body or a URL).

export const APP_UPDATE_PLATFORMS = ["ios", "android"] as const;
export const appUpdatePlatformSchema = z.enum(APP_UPDATE_PLATFORMS);
export type AppUpdatePlatform = z.infer<typeof appUpdatePlatformSchema>;

/**
 * Query: the shell's platform, its native build number (iOS `CFBundleVersion` / Android
 * `versionCode`) and the content id of the bundle it currently runs (builtin or OTA).
 */
export const appUpdateManifestQuerySchema = z.object({
  platform: appUpdatePlatformSchema,
  native: z.coerce.number().int().min(1).max(1_000_000),
  current: z.string().regex(APP_UPDATE_VERSION_RE).optional(),
});
export type AppUpdateManifestQuery = z.infer<typeof appUpdateManifestQuerySchema>;

/**
 * Why no update is offered, checked in this order: key missing / `APP_UPDATE_ENABLED=false` /
 * not a native client → `disabled`; manifest upstream missing or invalid → `unavailable`;
 * `native < minNativeBuild[platform]` → `native_too_old`; `current === version` → `up_to_date`.
 */
export const APP_UPDATE_REASONS = [
  "disabled",
  "unavailable",
  "native_too_old",
  "up_to_date",
] as const;
export const appUpdateReasonSchema = z.enum(APP_UPDATE_REASONS);
export type AppUpdateReason = z.infer<typeof appUpdateReasonSchema>;

/** Longest `manifestJson` the api sends and the phone accepts (1 MiB). */
export const APP_UPDATE_MANIFEST_JSON_MAX_CHARS = 1_048_576;
/** Longest DER ECDSA P-256 signature (72 bytes) as standard base64. */
export const APP_UPDATE_SIGNATURE_MAX_CHARS = 96;

/**
 * The signed envelope handed to `TinyglowUpdater.stage()` unchanged:
 * - `manifestJson`: the JSON text of a `signedAppUpdateManifestSchema` value (manifest + `baseUrl`);
 * - `signature`: ECDSA P-256 / SHA-256 over the UTF-8 bytes of `manifestJson`, DER, standard base64;
 * - `keyId`: the `APP_UPDATE_PUBLIC_KEYS` entry that verifies it.
 */
export const appUpdateEnvelopeSchema = z.object({
  manifestJson: z.string().min(1).max(APP_UPDATE_MANIFEST_JSON_MAX_CHARS),
  signature: z
    .string()
    .min(4)
    .max(APP_UPDATE_SIGNATURE_MAX_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64"),
  keyId: z.string().min(1).max(32),
});
export type AppUpdateEnvelope = z.infer<typeof appUpdateEnvelopeSchema>;

/**
 * `GET /app-update/manifest` → 200: `{ update: envelope }` (no `reason`) or
 * `{ update: null, reason }`.
 */
export const appUpdateManifestResponseSchema = z
  .object({
    update: appUpdateEnvelopeSchema.nullable(),
    reason: appUpdateReasonSchema.optional(),
  })
  .refine((r) => (r.update === null) === (r.reason !== undefined), {
    path: ["reason"],
    message: "reason is set exactly when update is null",
  });
export type AppUpdateManifestResponse = z.infer<typeof appUpdateManifestResponseSchema>;
