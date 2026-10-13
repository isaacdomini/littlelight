import { z } from "zod";
import {
  SHARE_LINK_NAME_MAX_CHARS,
  SHARE_PASSCODE_LENGTH,
  SHARE_PATH,
  SHARE_TOKEN_LENGTH,
  SHARE_TOKEN_MAX_LENGTH,
  SHARE_VIEWER_MEDIA_KINDS,
  SHARE_VIEWER_PAGE_MAX,
  SHARE_VIEWER_PAGE_SIZE,
  SHARE_VIEWER_URLS_MAX,
} from "../constants";
import { mediaKindSchema } from "../db-enums";
import { isoDateSchema, isoDateTimeSchema } from "./common";
import { durationMsSchema } from "./photos";

// Share-link viewer contracts (`/api/share/*`; PRD "FR-9 Sharing", "Accounts and authentication →
// Share-link viewers (no account)", "Privacy and child safety"; docs/plans/step-8.md 2.4, 2.6;
// docs/plans/step-12.md 2.3, 2.5). Browser-safe. A viewer has no account, no chat and no search:
// these routes are the whole surface.
//
// Rules:
// - The token travels only in the `POST /share/session` body (and the SPA's `/s/<token>` route,
//   which the API never sees); it is never echoed back, logged or stored in plaintext.
// - Response schemas here are **strict** (unlike the parent DTOs, which strip): a viewer payload
//   carrying any undeclared key — `babyId`, `caption`, `isSensitive`, `displayUrl`, GPS, an
//   original URL, an uploader id — fails to parse. The API parses every viewer response before
//   sending it, so a query that selects too much fails closed (500) instead of leaking.
// - Viewers never see AI captions or parent notes (D10), only age, date and milestone.
// - Media URLs are presigned GETs of one `thumb` or `display` derivative, or of a video's `web`
//   rendition (`viewerMediaUrlSchema` refuses anything else: never an original, `analysis` or a
//   keyframe); hidden (sensitive, not released) photos get no URL at all (D4). `web` is signed
//   only for `media_kind = 'video'` rows (the derivatives RLS policy gates it), with
//   `SHARE_VIDEO_URL_TTL_SEC`; a video download is the rendition, never the original (Q9).

/**
 * A share token as accepted on input: base64url, 22..64 chars. Minted tokens are exactly
 * `SHARE_TOKEN_LENGTH` (16 random bytes); the longer bound admits the dev seed token.
 */
export const shareTokenSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${SHARE_TOKEN_LENGTH},${SHARE_TOKEN_MAX_LENGTH}}$`));
export type ShareToken = z.infer<typeof shareTokenSchema>;

/** A share-link passcode: exactly `SHARE_PASSCODE_LENGTH` ASCII digits (never logged or echoed). */
export const sharePasscodeSchema = z
  .string()
  .regex(new RegExp(`^[0-9]{${SHARE_PASSCODE_LENGTH}}$`), "must be 6 digits");

/** Opaque keyset cursor (base64url), as the timeline's. */
export const shareCursorSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

/** The derivative kinds a viewer may get a URL for. */
export const viewerMediaKindSchema = z.enum(SHARE_VIEWER_MEDIA_KINDS);
export type ViewerMediaKind = z.infer<typeof viewerMediaKindSchema>;

/** Path tail of a viewer object key: `derivatives/{photoId}/{thumb|display}.jpg` or `…/web.mp4`. */
const VIEWER_MEDIA_PATH_RE = /\/derivatives\/[0-9a-f-]{36}\/(?:(?:thumb|display)\.jpg|web\.mp4)$/;

/**
 * A signed viewer media URL: http(s), and the object is a `thumb` or `display` derivative or a
 * video's `web` rendition. An original (`…/originals/…`), `analysis` or keyframe key can never
 * pass, whatever a query returned.
 */
export const viewerMediaUrlSchema = z.url({ protocol: /^https?$/ }).refine((u) => {
  try {
    return VIEWER_MEDIA_PATH_RE.test(new URL(u).pathname);
  } catch {
    return false;
  }
}, "must be a thumb, display or web derivative URL");

/**
 * A share link URL: `${PUBLIC_URL}/s/<token>`. Appears only in the create and regenerate
 * responses (D1); the client keeps it in memory only.
 */
export const shareUrlSchema = z.url({ protocol: /^https?$/ }).refine((u) => {
  try {
    const { pathname, search, hash } = new URL(u);
    const prefix = `${SHARE_PATH}/`;
    return (
      search === "" &&
      hash === "" &&
      pathname.startsWith(prefix) &&
      shareTokenSchema.safeParse(pathname.slice(prefix.length)).success
    );
  } catch {
    return false;
  }
}, "must be a share link URL");

// ---------------------------------------------------------------------------------------------
// Session exchange
// ---------------------------------------------------------------------------------------------

/**
 * `POST /share/session` body (requires `X-Tinyglow-Client`). Responses: 200
 * `shareSessionResponse` + `Set-Cookie: ll_viewer=…`; 401 `passcode_required` /
 * `passcode_invalid {attemptsLeft}`; 429 `rate_limited` / `passcode_locked` + `Retry-After`;
 * 410 `share_link_expired` for every dead or unknown link.
 */
export const shareSessionRequestSchema = z.strictObject({
  token: shareTokenSchema,
  passcode: sharePasscodeSchema.optional(),
});
export type ShareSessionRequest = z.infer<typeof shareSessionRequestSchema>;

/** The album header and counts (`GET /share/album`, and the exchange response). */
export const shareAlbumSchema = z.strictObject({
  /** The link's name ("Grandparents"). Render as text. */
  linkName: z.string().min(1).max(SHARE_LINK_NAME_MAX_CHARS),
  babyName: z.string().min(1),
  babyNickname: z.string().nullable(),
  allowDownload: z.boolean(),
  /** The link's expiry (also the viewer session's). */
  expiresAt: isoDateTimeSchema,
  /** Photos listed to this viewer, hidden tiles included. */
  photoCount: z.number().int().nonnegative(),
  /** Of those, sensitive photos not released by an admin (tiles without an image). */
  hiddenCount: z.number().int().nonnegative(),
});
export type ShareAlbum = z.infer<typeof shareAlbumSchema>;

/**
 * `viewerToken` is present only for `X-Tinyglow-Client: native` (step 9: the app stores it
 * and sends `Authorization: Bearer`); the web gets the httpOnly cookie and never this field.
 */
export const shareSessionResponseSchema = z.strictObject({
  album: shareAlbumSchema,
  viewerToken: z.string().min(1).optional(),
});
export type ShareSessionResponse = z.infer<typeof shareSessionResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Album photos
// ---------------------------------------------------------------------------------------------

/**
 * One photo as a viewer sees it. Deliberately minimal (D10): no `babyId`, status, approval,
 * uploader, caption, AI fields, note, people, place, GPS, `isSensitive` (only `hidden`), mime or
 * `displayUrl` (display URLs come from `POST /share/photos/urls` for the slides on screen).
 * `hidden` = sensitive and not released to this link by an admin: no URL, the client renders a
 * frosted placeholder and requests no image. `mediaKind`/`durationMs` (step 12) drive the tile's
 * duration badge and the player; the viewer `SELECT` grant covers exactly these two new columns.
 */
export const viewerPhotoSchema = z
  .strictObject({
    id: z.uuid(),
    mediaKind: mediaKindSchema,
    durationMs: durationMsSchema,
    /**
     * Capture date only, `YYYY-MM-DD` in UTC (docs/plans/review-fixes.md 2.11, D19): no time of
     * day reaches a viewer. The viewer role cannot read the EXIF offset, so a late-evening photo
     * east of UTC can show the next day. Render as a calendar date (no `Date` time-zone shift).
     */
    takenAt: isoDateSchema.nullable(),
    takenAtEstimated: z.boolean(),
    ageDays: z.number().int().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    /** The parent-tagged milestone (preset or custom name). */
    milestone: z.strictObject({ id: z.uuid(), name: z.string().min(1) }).nullable(),
    hidden: z.boolean(),
    /** Signed `thumb` URL; always null when `hidden` (and until the thumb exists). */
    thumbUrl: viewerMediaUrlSchema.nullable(),
    /** Expiry of `thumbUrl`; null when there is none. */
    urlExpiresAt: isoDateTimeSchema.nullable(),
  })
  .refine((p) => !p.hidden || (p.thumbUrl === null && p.urlExpiresAt === null), {
    path: ["thumbUrl"],
    message: "a hidden photo has no URL",
  })
  .refine((p) => (p.thumbUrl === null) === (p.urlExpiresAt === null), {
    path: ["urlExpiresAt"],
    message: "set exactly when thumbUrl is set",
  });
export type ViewerPhoto = z.infer<typeof viewerPhotoSchema>;

/** `GET /share/photos` query (strings coerced). */
export const viewerPhotosQuerySchema = z.object({
  cursor: shareCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(SHARE_VIEWER_PAGE_MAX).default(SHARE_VIEWER_PAGE_SIZE),
});
export type ViewerPhotosQuery = z.infer<typeof viewerPhotosQuerySchema>;

/** Newest first (`sort_at DESC, id DESC`); `nextCursor` null on the last page. */
export const viewerPhotosResponseSchema = z.strictObject({
  photos: z.array(viewerPhotoSchema),
  nextCursor: shareCursorSchema.nullable(),
});
export type ViewerPhotosResponse = z.infer<typeof viewerPhotosResponseSchema>;

/**
 * `POST /share/photos/urls`: fresh URLs of one kind for the given ids. `kind: "web"` (step 12)
 * yields entries for video rows only (TTL `SHARE_VIDEO_URL_TTL_SEC`); photos are omitted.
 */
export const viewerUrlsRequestSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(SHARE_VIEWER_URLS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, "ids must be unique"),
  kind: viewerMediaKindSchema,
});
export type ViewerUrlsRequest = z.infer<typeof viewerUrlsRequestSchema>;

/** Ids that are hidden, not shared with this link, or unknown are silently omitted. */
export const viewerUrlsResponseSchema = z.strictObject({
  urls: z.array(
    z.strictObject({
      id: z.uuid(),
      url: viewerMediaUrlSchema,
      expiresAt: isoDateTimeSchema,
    }),
  ),
});
export type ViewerUrlsResponse = z.infer<typeof viewerUrlsResponseSchema>;

/**
 * `POST /share/photos/:id/download`: 403 `forbidden` unless the link allows downloads; 404 for a
 * hidden or non-shared photo. The URL is the 1600 px `display` derivative (metadata-free, never
 * the original, D9) as an attachment, valid `SHARE_DOWNLOAD_URL_TTL_SEC`; for a video the `web`
 * rendition as `attachment; filename="<id>.mp4"` (Q9), never the original.
 */
export const viewerDownloadResponseSchema = z.strictObject({
  url: viewerMediaUrlSchema,
  expiresAt: isoDateTimeSchema,
});
export type ViewerDownloadResponse = z.infer<typeof viewerDownloadResponseSchema>;

/**
 * `GET /share/manifest.webmanifest?t=<token>` query (public, no DB, D11): the installed PWA's
 * `start_url` is `/s/<t>`. An invalid token shape is a 400. The query string never reaches a log.
 */
export const shareManifestQuerySchema = z.object({ t: shareTokenSchema });
export type ShareManifestQuery = z.infer<typeof shareManifestQuerySchema>;
