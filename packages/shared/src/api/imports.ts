import { z } from "zod";
import {
  IMPORT_ALBUM_TITLE_MAX,
  IMPORT_BATCHES_LIST_DEFAULT,
  IMPORT_BATCHES_LIST_MAX,
  IMPORT_DEVICE_LABEL_MAX,
  IMPORT_SOURCE_DELTA_MAX,
  IMPORT_SOURCES_LIST_MAX,
} from "../imports";
import { isoDateTimeSchema } from "./common";

// Photo import contracts (docs/plans/step-10.md 2.3, 2.6; PRD FR-2.1, FR-2.6, FR-2.7, "Roles and
// permissions"). Browser-safe.
//
// Rules:
// - Apple album sync (`/me/import-sources`, `/babies/:id/import-sources`, `/import-sources/:id`):
//   admins create rows (D1, the INSERT policy); the server stores per-device status counters only.
//   PHAsset identifiers, file names and paths never appear in any schema here (D3).
// - Google Picker import (`/me/import/google/*`, `/babies/:id/imports/google`, `/imports/:batchId`):
//   admins and contributors (D1); a contributor's photos land `pending`. `pickerUri` appears only
//   in `importBatchCreateResponseSchema` (never stored, never logged); the connect `url` only in
//   `googleConnectResponseSchema`. Tokens, Google session ids and item ids never reach the wire.
// - Response schemas are **strict** (a row mapper that adds a column fails instead of leaking it);
//   request bodies are strict too (an unexpected key, e.g. a PHAsset id, is a 400).
// - Enum values match the migration CHECKs (`1792300000300_photo-import.sql`) literally and in order.

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** Parent-entered label: trimmed, no control characters (mirrors the `import_sources_shape` trigger). */
function labelSchema(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/\p{Cc}/u.test(s), "must not contain control characters");
}

const counterSchema = z.number().int().nonnegative();
const deltaSchema = z.number().int().min(0).max(IMPORT_SOURCE_DELTA_MAX);

// ---------------------------------------------------------------------------------------------
// Apple Photos album sync (`import_sources`)
// ---------------------------------------------------------------------------------------------

/** `import_sources.kind`. */
export const IMPORT_SOURCE_KINDS = ["apple_photos"] as const;
export const importSourceKindSchema = z.enum(IMPORT_SOURCE_KINDS);
export type ImportSourceKind = z.infer<typeof importSourceKindSchema>;

/** `import_sources.last_trigger`: what started the last sync run on the device. */
export const SYNC_TRIGGERS = ["launch", "resume", "manual", "background"] as const;
export const syncTriggerSchema = z.enum(SYNC_TRIGGERS);
export type SyncTrigger = z.infer<typeof syncTriggerSchema>;

/**
 * `import_sources.last_error`: `free_tier_limit` (the family's free albums are full; the run
 * stopped), `permission_denied` (Photos access is not "Full"), `album_missing` (the album was
 * deleted), `network`, `storage_error`, `baby_trashed`, `signed_out` (written by the sign-out
 * hook), `pending_limit` (step 11: the guest's pending queue in this family is full; the run
 * stopped).
 */
export const IMPORT_SOURCE_ERRORS = [
  "free_tier_limit",
  "permission_denied",
  "album_missing",
  "network",
  "storage_error",
  "baby_trashed",
  "signed_out",
  "pending_limit",
] as const;
export const importSourceErrorSchema = z.enum(IMPORT_SOURCE_ERRORS);
export type ImportSourceError = z.infer<typeof importSourceErrorSchema>;

/**
 * One device's sync status for one baby, as the caller sees it (RLS: own rows, or every row of a
 * baby the caller admins).
 * - `userName` is the owner's display name from `member_profiles` (null when unknown).
 * - `isMine` = owned by the caller (only the owner may `PATCH`).
 * - `isThisDevice` = `deviceId` equals the `deviceId` query parameter of the list request (the
 *   caller's install id); false when none was sent.
 */
export const importSourceSchema = z.strictObject({
  id: z.uuid(),
  babyId: z.uuid(),
  userId: z.uuid(),
  userName: z.string().nullable(),
  kind: importSourceKindSchema,
  deviceId: z.uuid(),
  deviceLabel: z.string().min(1).max(IMPORT_DEVICE_LABEL_MAX),
  albumTitle: z.string().min(1).max(IMPORT_ALBUM_TITLE_MAX),
  wifiOnly: z.boolean(),
  paused: z.boolean(),
  isMine: z.boolean(),
  isThisDevice: z.boolean(),
  lastSyncAt: isoDateTimeSchema.nullable(),
  lastTrigger: syncTriggerSchema.nullable(),
  importedCount: counterSchema,
  duplicateCount: counterSchema,
  failedCount: counterSchema,
  skippedCount: counterSchema,
  lastError: importSourceErrorSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type ImportSource = z.infer<typeof importSourceSchema>;

/**
 * `GET /me/import-sources?babyId=&deviceId=` query: `babyId` required (member); `deviceId` (the
 * caller's install id, `ll.install.v1`) only sets `isThisDevice` and filters nothing.
 */
export const importSourcesListQuerySchema = z.object({
  babyId: z.uuid(),
  deviceId: z.uuid().optional(),
});
export type ImportSourcesListQuery = z.infer<typeof importSourcesListQuerySchema>;

/**
 * `POST /babies/:id/import-sources` body (admin only; a contributor gets 403 `forbidden`). Upsert
 * on `(deviceId, babyId, kind)`: re-enabling un-pauses and clears `lastError`. 201 on insert,
 * 200 on update, `importSourceResponseSchema`; 409 `import_source_exists` (another user's row
 * for this device), `import_source_limit`, `baby_trashed`.
 */
export const upsertImportSourceRequestSchema = z.strictObject({
  kind: importSourceKindSchema,
  deviceId: z.uuid(),
  deviceLabel: labelSchema(IMPORT_DEVICE_LABEL_MAX),
  albumTitle: labelSchema(IMPORT_ALBUM_TITLE_MAX),
  wifiOnly: z.boolean(),
});
export type UpsertImportSourceRequest = z.infer<typeof upsertImportSourceRequestSchema>;

/**
 * `PATCH /import-sources/:id` body (owner only). Counter fields are **deltas** added server-side
 * (`col = col + $n`, so two runs never lose updates), each 0..`IMPORT_SOURCE_DELTA_MAX`.
 * `lastError: null` clears the error. At least one field is required.
 */
export const patchImportSourceRequestSchema = z
  .strictObject({
    albumTitle: labelSchema(IMPORT_ALBUM_TITLE_MAX).optional(),
    wifiOnly: z.boolean().optional(),
    paused: z.boolean().optional(),
    lastSyncAt: isoDateTimeSchema.optional(),
    lastTrigger: syncTriggerSchema.optional(),
    importedDelta: deltaSchema.optional(),
    duplicateDelta: deltaSchema.optional(),
    failedDelta: deltaSchema.optional(),
    skippedDelta: deltaSchema.optional(),
    lastError: importSourceErrorSchema.nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "at least one field is required",
  });
export type PatchImportSourceRequest = z.infer<typeof patchImportSourceRequestSchema>;

/** `GET /me/import-sources` 200. */
export const importSourcesListResponseSchema = z.strictObject({
  sources: z.array(importSourceSchema).max(IMPORT_SOURCES_LIST_MAX),
});
export type ImportSourcesListResponse = z.infer<typeof importSourcesListResponseSchema>;

/** `POST /babies/:id/import-sources` 201/200 and `PATCH /import-sources/:id` 200. */
export const importSourceResponseSchema = z.strictObject({ source: importSourceSchema });
export type ImportSourceResponse = z.infer<typeof importSourceResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Google connection
// ---------------------------------------------------------------------------------------------

/**
 * `GET /me/import/google/connection` 200. `available` = the server's `GOOGLE_IMPORT_PROVIDER` is
 * not `none` (the UI hides Google import otherwise); `needsReconnect` = Google refused the stored
 * refresh token (revoked / expired); the UI offers "Reconnect Google".
 */
export const googleConnectionSchema = z.strictObject({
  available: z.boolean(),
  connected: z.boolean(),
  connectedAt: isoDateTimeSchema.nullable(),
  needsReconnect: z.boolean(),
});
export type GoogleConnection = z.infer<typeof googleConnectionSchema>;

/** SPA paths the connect flow may return to (`returnTo`); nothing else is ever redirected to. */
export const GOOGLE_CONNECT_RETURN_PATHS = ["/upload", "/settings/import"] as const;
export const googleConnectReturnPathSchema = z.enum(GOOGLE_CONNECT_RETURN_PATHS);
export type GoogleConnectReturnPath = z.infer<typeof googleConnectReturnPathSchema>;

/**
 * `POST /me/import/google/connect` body. `client` decides the connected page's copy (`native`:
 * "Return to Tinyglow"). 404 `feature_unavailable` when the provider is `none`; 429
 * `rate_limited`.
 */
export const googleConnectRequestSchema = z.strictObject({
  client: z.enum(["web", "native"]),
  returnTo: googleConnectReturnPathSchema.default("/upload"),
});
/** Parsed body (server side: `returnTo` filled in). */
export type GoogleConnectRequest = z.infer<typeof googleConnectRequestSchema>;
/** Body as sent (client side: `returnTo` may be omitted). */
export type GoogleConnectRequestInput = z.input<typeof googleConnectRequestSchema>;

/** `POST /me/import/google/connect` 200: the consent URL, opened at once (system browser on native). */
export const googleConnectResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
});
export type GoogleConnectResponse = z.infer<typeof googleConnectResponseSchema>;

/** SPA route the OAuth callback redirects to: `${GOOGLE_CONNECTED_PATH}?status=…&client=…[&returnTo=…]`. */
export const GOOGLE_CONNECTED_PATH = "/import/google/connected";

/**
 * `status` of the connected page: `ok`; `denied` (the user pressed Deny); `scope_missing` (consent
 * without the Picker scope, or no refresh token); `expired` (the `state` was invalid, expired or
 * its sign-in session ended); `error` (Google's token exchange failed).
 */
export const GOOGLE_CONNECT_STATUSES = [
  "ok",
  "denied",
  "scope_missing",
  "expired",
  "error",
] as const;
export const googleConnectStatusSchema = z.enum(GOOGLE_CONNECT_STATUSES);
export type GoogleConnectStatus = z.infer<typeof googleConnectStatusSchema>;

/** Query of `GOOGLE_CONNECTED_PATH` (the SPA parses it; unknown values fall back to `error` / `web`). */
export const googleConnectedQuerySchema = z.object({
  status: googleConnectStatusSchema.catch("error"),
  client: z.enum(["web", "native"]).catch("web"),
  returnTo: googleConnectReturnPathSchema.optional().catch(undefined),
});
export type GoogleConnectedQuery = z.infer<typeof googleConnectedQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Google Picker batches (`import_batches`, `import_items`)
// ---------------------------------------------------------------------------------------------

/** `import_batches.kind`. */
export const IMPORT_BATCH_KINDS = ["google_picker"] as const;
export const importBatchKindSchema = z.enum(IMPORT_BATCH_KINDS);
export type ImportBatchKind = z.infer<typeof importBatchKindSchema>;

/**
 * `import_batches.status`: `picking` (the user is in Google's picker) → `queued` (items picked,
 * job sent) → `running` (worker) → `done` | `failed`; `picking` → `cancelled` | `expired`;
 * `queued`/`running` → `cancelled` after a cancel request.
 */
export const IMPORT_BATCH_STATUSES = [
  "picking",
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
  "expired",
] as const;
export const importBatchStatusSchema = z.enum(IMPORT_BATCH_STATUSES);
export type ImportBatchStatus = z.infer<typeof importBatchStatusSchema>;

/** Statuses in which the client keeps polling `GET /imports/:batchId`. */
export const IMPORT_BATCH_ACTIVE_STATUSES = [
  "picking",
  "queued",
  "running",
] as const satisfies readonly ImportBatchStatus[];

/** `import_batches.error` (with `failed`, or `too_many_items` when no item could be taken). */
export const IMPORT_BATCH_ERRORS = [
  "google_denied",
  "google_reconnect",
  "session_expired",
  "storage_error",
  "requester_not_member",
  "baby_trashed",
  "too_many_items",
  "internal",
] as const;
export const importBatchErrorSchema = z.enum(IMPORT_BATCH_ERRORS);
export type ImportBatchError = z.infer<typeof importBatchErrorSchema>;

/** `import_items.status`. */
export const IMPORT_ITEM_STATUSES = [
  "pending",
  "downloaded",
  "booked",
  "duplicate",
  "failed",
  "skipped",
] as const;
export const importItemStatusSchema = z.enum(IMPORT_ITEM_STATUSES);
export type ImportItemStatus = z.infer<typeof importItemStatusSchema>;

/**
 * `import_items.error`; step 11 appends `pending_limit` (`import_book_photo()` outcome when the
 * requester's pending queue in this family is full).
 */
export const IMPORT_ITEM_ERRORS = [
  "unsupported_media_type",
  "file_too_large",
  "download_failed",
  "free_tier_limit",
  "storage_error",
  "not_member",
  "baby_trashed",
  "pending_limit",
] as const;
export const importItemErrorSchema = z.enum(IMPORT_ITEM_ERRORS);
export type ImportItemError = z.infer<typeof importItemErrorSchema>;

/**
 * One Picker batch as the caller sees it (RLS: own batches, or every batch of a baby the caller
 * admins). Never carries the Google session id, item ids, URLs or tokens.
 * - `requestedBy` is null once the requester's account was deleted; `requestedByName` from
 *   `member_profiles`. `isMine` = requested by the caller (only the requester may cancel).
 * - `itemsTotal` is null until the worker listed the picked items.
 * - `pollIntervalSec`: how often the client polls while the batch is active.
 */
export const importBatchSchema = z.strictObject({
  id: z.uuid(),
  babyId: z.uuid(),
  kind: importBatchKindSchema,
  status: importBatchStatusSchema,
  error: importBatchErrorSchema.nullable(),
  requestedBy: z.uuid().nullable(),
  requestedByName: z.string().nullable(),
  isMine: z.boolean(),
  itemsTotal: counterSchema.nullable(),
  itemsImported: counterSchema,
  itemsDuplicate: counterSchema,
  itemsFailed: counterSchema,
  itemsSkipped: counterSchema,
  pollIntervalSec: z.number().int().min(1).max(60),
  pickerExpiresAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

/** Route params `/imports/:batchId` and `/imports/:batchId/cancel`. */
export const importBatchParamsSchema = z.object({ batchId: z.uuid() });
export type ImportBatchParams = z.infer<typeof importBatchParamsSchema>;

/** `GET /babies/:id/imports?limit=` query (default `IMPORT_BATCHES_LIST_DEFAULT`). */
export const importBatchesListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(IMPORT_BATCHES_LIST_MAX)
    .default(IMPORT_BATCHES_LIST_DEFAULT),
});
export type ImportBatchesListQuery = z.infer<typeof importBatchesListQuerySchema>;

/**
 * `POST /babies/:id/imports/google` body: empty (no batch details at import time, D17). 409
 * `google_not_connected`, `google_reconnect`, `import_in_progress`, `baby_trashed`; 429
 * `rate_limited`; 404 `feature_unavailable` when the provider is `none`.
 */
export const importBatchCreateRequestSchema = z.strictObject({});
export type ImportBatchCreateRequest = z.infer<typeof importBatchCreateRequestSchema>;

/**
 * `POST /babies/:id/imports/google` 201. **The only response that carries `pickerUri`**: the
 * client opens it at once (system browser on native) and keeps it nowhere; the api never stores
 * or logs it.
 */
export const importBatchCreateResponseSchema = z.strictObject({
  batch: importBatchSchema,
  pickerUri: z.url({ protocol: /^https?$/ }),
});
export type ImportBatchCreateResponse = z.infer<typeof importBatchCreateResponseSchema>;

/** `GET /imports/:batchId` and `POST /imports/:batchId/cancel` 200. */
export const importBatchResponseSchema = z.strictObject({ batch: importBatchSchema });
export type ImportBatchResponse = z.infer<typeof importBatchResponseSchema>;

/** `GET /babies/:id/imports` 200, newest first. */
export const importBatchesListResponseSchema = z.strictObject({
  batches: z.array(importBatchSchema).max(IMPORT_BATCHES_LIST_MAX),
});
export type ImportBatchesListResponse = z.infer<typeof importBatchesListResponseSchema>;
