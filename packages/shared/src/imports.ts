import type { MediaKind } from "./db-enums";
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES_PER_SESSION,
  UPLOAD_MAX_VIDEO_BYTES,
} from "./upload";

// Photo import constants (docs/plans/step-10.md 2.3; PRD FR-2.1, FR-2.6 "Optional auto-backup ...
// on Wi-Fi (user opt-in)", FR-2.7). Browser-safe: no Node imports. Two flows share them:
// - Apple Photos album sync (iPhone only, admins only, D1): PhotoKit on the device, the existing
//   upload pipeline, per-device status rows in `import_sources` (counters only; PHAsset
//   identifiers, file names and paths never leave the device, D3).
// - Google Photos Picker import (web, Android, iPhone; admins and contributors, D1): server-side
//   OAuth, the worker downloads the picked originals (`import.google`).
// Imports are available on Free within the free photo cap (D8); nothing here touches the AI gate.

// ---------------------------------------------------------------------------------------------
// Google Picker batches (server)
// ---------------------------------------------------------------------------------------------

/** Items one Google Picker batch may import (parity with an upload session, D11); the rest are skipped. */
export const IMPORT_BATCH_MAX_ITEMS: number = UPLOAD_MAX_FILES_PER_SESSION;
/** Picker batches per baby per rolling 24 h (`import_batches_one_active` trigger). */
export const IMPORT_BATCHES_PER_BABY_PER_DAY = 20;
/** `POST /babies/:id/imports/google` per user per hour (api throttle). */
export const IMPORT_BATCHES_PER_USER_PER_HOUR = 10;
/** `POST /me/import/google/connect` per user per hour (api throttle). */
export const IMPORT_CONNECTS_PER_USER_PER_HOUR = 10;
/** Floor of `import_batches.poll_interval_sec`: the api asks Google at most this often per batch (D19). */
export const IMPORT_PICKER_POLL_MIN_SEC = 3;
/** A batch still `picking` this long after creation expires (`picker_expires_at` cap, `import.sweep`). */
export const IMPORT_PICKING_TTL_MIN = 30;
/** Largest **photo** original the worker downloads (= `UPLOAD_MAX_FILE_BYTES`, 100 MiB). */
export const IMPORT_MAX_FILE_BYTES: number = UPLOAD_MAX_FILE_BYTES;
/**
 * Largest **video** original the worker downloads (= `UPLOAD_MAX_VIDEO_BYTES`, the
 * `import_items.bytes` CHECK since migration 22); the per-plan cap (`videoLimitsFor(plan).maxBytes`)
 * is applied on top by the worker and by `import_book_photo()` (step 12, D of 2.2).
 */
export const IMPORT_MAX_VIDEO_BYTES: number = UPLOAD_MAX_VIDEO_BYTES;

/** The download cap for one import item by media kind. */
export function importMaxBytesFor(kind: MediaKind): number {
  return kind === "video" ? IMPORT_MAX_VIDEO_BYTES : IMPORT_MAX_FILE_BYTES;
}
/** Default and most batches of `GET /babies/:id/imports?limit=` (`importBatchesListResponseSchema`). */
export const IMPORT_BATCHES_LIST_DEFAULT = 10;
export const IMPORT_BATCHES_LIST_MAX = 20;

// ---------------------------------------------------------------------------------------------
// Apple Photos album sync (device + `import_sources`)
// ---------------------------------------------------------------------------------------------

/** `import_sources` rows per baby (`import_sources_cap` trigger: 'import source limit reached'). */
export const IMPORT_SOURCES_PER_BABY_MAX = 10;
/** Most rows of `GET /me/import-sources` (`importSourcesListResponseSchema`). */
export const IMPORT_SOURCES_LIST_MAX = 50;
/** `import_sources.device_label` length ("Dad's iPhone"; `import_sources_shape` trigger). */
export const IMPORT_DEVICE_LABEL_MAX = 60;
/** `import_sources.album_title` length (`import_sources_shape` trigger). */
export const IMPORT_ALBUM_TITLE_MAX = 120;
/** Most a single `PATCH /import-sources/:id` may add to one counter (one run of batches). */
export const IMPORT_SOURCE_DELTA_MAX = 500;
/** Assets per foreground sync batch (newest first, D4). */
export const SYNC_FOREGROUND_BATCH = 50;
/** Assets per background-refresh wake (one batch, D4, D13). */
export const SYNC_BACKGROUND_BATCH = 25;
/** Sync-lane uploads in flight at once (of `UPLOAD_CONCURRENCY`; the user's own uploads go first). */
export const SYNC_LANE_CONCURRENCY = 2;
/** Export/upload attempts per asset before the device ledger marks it `skipped`. */
export const SYNC_ASSET_MAX_ATTEMPTS = 3;
/** A launch/resume/background run within this many seconds of the last run does nothing ("Sync now" always runs). */
export const SYNC_MIN_INTERVAL_SEC = 60;
/** `BGAppRefreshTask` identifier (`BGTaskSchedulerPermittedIdentifiers` in both iOS plists). */
export const SYNC_BG_TASK_ID = "app.tinyglow.sync";

// ---------------------------------------------------------------------------------------------
// Google endpoints and scope
// ---------------------------------------------------------------------------------------------

/** The only OAuth scope requested: read access to the items the user picks, nothing else. */
export const GOOGLE_PICKER_SCOPE =
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

/**
 * Live Google endpoints. With `GOOGLE_IMPORT_PROVIDER=fake` the api/worker use the fake's base
 * URL with the same paths (`/o/oauth2/v2/auth`, `/token`, `/revoke`, `/v1/...`).
 */
export const GOOGLE_ENDPOINTS = {
  AUTH: "https://accounts.google.com/o/oauth2/v2/auth",
  TOKEN: "https://oauth2.googleapis.com/token",
  REVOKE: "https://oauth2.googleapis.com/revoke",
  PICKER: "https://photospicker.googleapis.com",
} as const;

/** Default of `GOOGLE_IMPORT_MEDIA_HOSTS`: host suffix of every Picker `baseUrl` (`lh3.googleusercontent.com`, …). */
export const GOOGLE_MEDIA_HOST_SUFFIX_DEFAULT = "googleusercontent.com";

/**
 * Picker `baseUrl` suffix that downloads the original bytes: `=d` for a photo, `=dv` for a video
 * (Google strips location from both, D20). `mediaDownloadUrl` in google-photos.ts is the photo
 * form; `googleMediaDownloadUrl` chooses by kind.
 */
export const GOOGLE_MEDIA_DOWNLOAD_SUFFIX = { photo: "=d", video: "=dv" } as const satisfies Record<
  MediaKind,
  string
>;

/** Download URL of a picked item's original bytes: `baseUrl + "=d"` (photo) or `baseUrl + "=dv"` (video). */
export function googleMediaDownloadUrl(baseUrl: string, kind: MediaKind): string {
  return `${baseUrl}${GOOGLE_MEDIA_DOWNLOAD_SUFFIX[kind]}`;
}
