import { z } from "zod";
import { GOOGLE_PICKER_SCOPE } from "./imports";

// Google OAuth + Photos Picker payloads the server consumes, and the download URL guard
// (docs/plans/step-10.md 2.3, 2.7, D6, R5). Browser-safe: zod and the WHATWG `URL` only.
//
// - Response schemas are plain `z.object`s (unknown keys stripped): Google may add fields, and a
//   stripped object can never carry them further. Proto3 JSON omits default values, so `false`
//   booleans and empty lists may be absent; the schemas default them.
// - Tokens, codes, `pickerUri` and `baseUrl` values parsed here are secrets or capabilities: never
//   log them, never store them (except the encrypted refresh token), never put them in an error
//   message. `TELEMETRY_SCRUB_PATTERNS` and the pino redaction lists cover their shapes.
// - Every download URL passes `parseAllowedMediaUrl` before the worker fetches it, and every
//   redirect passes `resolveMediaRedirect` (fetch with `redirect: "manual"`).

// ---------------------------------------------------------------------------------------------
// OAuth token endpoint
// ---------------------------------------------------------------------------------------------

/**
 * `POST /token` success (`authorization_code` or `refresh_token` grant). `refresh_token` is
 * present only on a consent with `access_type=offline` + `prompt=consent`; `scope` is the
 * space-separated granted list (check it with `scopeIncludesPicker`).
 */
export const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(4096).optional(),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer", "must be a Bearer token"),
  /** Seconds until the refresh token expires (Google sets it for apps in "Testing", R4). */
  refresh_token_expires_in: z.number().int().positive().optional(),
});
export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

/**
 * `POST /token` error body (4xx). `invalid_grant` means the refresh token was revoked or expired:
 * the caller sets `google_accounts.needs_reconnect` (`import_mark_reconnect`). The description is
 * Google's text: never log it verbatim (it may quote the request).
 */
export const googleTokenErrorSchema = z.object({
  error: z.string().min(1).max(128),
  error_description: z.string().max(1024).optional(),
});
export type GoogleTokenError = z.infer<typeof googleTokenErrorSchema>;

/** True when the space-separated `scope` grant contains `GOOGLE_PICKER_SCOPE`. */
export function scopeIncludesPicker(scope: string | undefined | null): boolean {
  if (typeof scope !== "string") return false;
  return scope.split(/\s+/).includes(GOOGLE_PICKER_SCOPE);
}

// ---------------------------------------------------------------------------------------------
// Picker sessions and media items
// ---------------------------------------------------------------------------------------------

/** A protobuf JSON `Duration`: decimal seconds with an `s` suffix (`"5s"`, `"1800s"`, `"3.5s"`). */
const GOOGLE_DURATION_RE = /^(\d{1,9})(?:\.(\d{1,9}))?s$/;
export const googleDurationSchema = z
  .string()
  .regex(GOOGLE_DURATION_RE, "must be a duration like 5s");

/**
 * Seconds of a protobuf JSON `Duration` (`parseGoogleDuration("5s") === 5`, `"3.5s"` ⇒ 3.5).
 * Throws `RangeError` for anything else (no sign, no unit other than `s`, ≤ 9 integer digits).
 */
export function parseGoogleDuration(value: string): number {
  const m = typeof value === "string" ? GOOGLE_DURATION_RE.exec(value) : null;
  if (!m) throw new RangeError("not a Google duration");
  return Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0);
}

/** `http(s)` URL only (never `javascript:`, `data:`, `file:`): the client opens `pickerUri`. */
const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(4096);

/**
 * `POST /v1/sessions` and `GET /v1/sessions/{id}` (Picker `PickingSession`). `pickerUri` goes to
 * the client once (`importBatchCreateResponseSchema`) and is never stored or logged; `id` is
 * stored as `import_batches.provider_session_id` (not granted to users).
 */
export const pickerSessionSchema = z.object({
  id: z.string().min(1).max(256),
  pickerUri: httpUrlSchema,
  pollingConfig: z
    .object({
      pollInterval: googleDurationSchema.optional(),
      timeoutIn: googleDurationSchema.optional(),
    })
    .optional(),
  expireTime: z.iso.datetime({ offset: true }).optional(),
  mediaItemsSet: z.boolean().default(false),
});
export type PickerSession = z.infer<typeof pickerSessionSchema>;

/** Picker `type` values; unknown future values parse as `TYPE_UNSPECIFIED` (skipped as unsupported). */
export const PICKER_MEDIA_TYPES = ["TYPE_UNSPECIFIED", "PHOTO", "VIDEO"] as const;
export const pickerMediaTypeSchema = z.enum(PICKER_MEDIA_TYPES).catch("TYPE_UNSPECIFIED");
export type PickerMediaType = (typeof PICKER_MEDIA_TYPES)[number];

/** A JSON integer that proto3 may serialize as a string (`int64`). */
const jsonIntSchema = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^\d{1,12}$/)
    .transform(Number),
]);

/**
 * One `PickedMediaItem`. `baseUrl` is a short-lived capability (~60 min, needs the bearer token):
 * kept in worker memory for one run only. `filename` is the user's file name: never stored,
 * never logged. `mediaFileMetadata` has dimensions and camera, never GPS (D20).
 */
export const pickerMediaItemSchema = z.object({
  id: z.string().min(1).max(512),
  createTime: z.iso.datetime({ offset: true }),
  type: pickerMediaTypeSchema,
  mediaFile: z.object({
    baseUrl: httpUrlSchema,
    mimeType: z.string().min(1).max(255),
    filename: z.string().max(1024).optional(),
    mediaFileMetadata: z
      .object({
        width: jsonIntSchema.optional(),
        height: jsonIntSchema.optional(),
        cameraMake: z.string().max(255).optional(),
        cameraModel: z.string().max(255).optional(),
      })
      .optional(),
  }),
});
export type PickerMediaItem = z.infer<typeof pickerMediaItemSchema>;

/** `GET /v1/mediaItems?sessionId=…&pageSize=100&pageToken=…`; an empty `nextPageToken` means the end. */
export const pickerMediaItemsPageSchema = z.object({
  mediaItems: z.array(pickerMediaItemSchema).max(100).default([]),
  nextPageToken: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.string().min(1).max(4096).optional(),
  ),
});
export type PickerMediaItemsPage = z.infer<typeof pickerMediaItemsPageSchema>;

/** Download URL of a picked photo's original bytes with metadata (Google strips location, D20). */
export function mediaDownloadUrl(baseUrl: string): string {
  return `${baseUrl}=d`;
}

// ---------------------------------------------------------------------------------------------
// Download URL guard (SSRF, D6, R5)
// ---------------------------------------------------------------------------------------------

/** Longest download URL accepted (a `baseUrl` is a few hundred characters). */
export const MEDIA_URL_MAX_CHARS = 4096;
/** Redirects the worker follows per download (each one re-checked by `resolveMediaRedirect`). */
export const IMPORT_MEDIA_MAX_REDIRECTS = 2;

export interface MediaUrlGuardOptions {
  /**
   * Exact origins (`scheme://host[:port]`) allowed as they are, http, ports and IP literals
   * included. Only for the dev/test fake (`GOOGLE_IMPORT_PROVIDER=fake`, refused in production):
   * build it with `googleImportMediaAllowList`, never from request data.
   */
  readonly exactOrigins?: readonly string[];
}

/** Characters never accepted in a download URL (whitespace, controls, `\` which WHATWG reads as `/`). */
const UNSAFE_URL_CHARS_RE = /[\s\\\p{Cc}]/u;
/** A hostname label: letters, digits, inner hyphens. */
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A suffix as accepted by the guard: lowercase, ≥ 2 labels, the last one not numeric. */
function normalizeSuffix(suffix: unknown): string | null {
  if (typeof suffix !== "string") return null;
  const s = suffix.trim().toLowerCase().replace(/^\.+/, "");
  const labels = s.split(".");
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL_RE.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1] ?? "")) return null;
  return s;
}

/** True for an IP literal host (`[::1]`, `127.0.0.1`) or any host whose last label is numeric. */
function isIpLiteralHost(hostname: string): boolean {
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  const last = hostname.split(".").pop() ?? "";
  return /^(0x[0-9a-f]*|\d+)$/i.test(last);
}

function normalizeOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const o of origins ?? []) {
    try {
      const u = new URL(o);
      if (
        (u.protocol === "http:" || u.protocol === "https:") &&
        u.username === "" &&
        u.password === ""
      ) {
        out.add(u.origin);
      }
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

/**
 * Parses `url` and returns it only when it may be fetched as a Google media download (D6):
 * - `https:` only, no explicit port, no user-info, no fragment, at most `MEDIA_URL_MAX_CHARS`,
 *   no whitespace, control characters or backslashes anywhere in the input;
 * - the host is not an IP literal, has no trailing dot, and equals a suffix of `hostSuffixes` or
 *   ends with `.` + that suffix (`lh3.googleusercontent.com` matches `googleusercontent.com`;
 *   `evil-googleusercontent.com` and `googleusercontent.com.evil.test` do not). Invalid suffixes
 *   (one label, numeric, empty) are ignored, so a bad config allows less, never more;
 * - or its origin is one of `options.exactOrigins` (the dev/test fake only).
 * Callers fetch the returned `URL#href`, the exact string that was checked (no parser
 * differential). Returns `null` otherwise; never throws.
 */
export function parseAllowedMediaUrl(
  url: string,
  hostSuffixes: readonly string[],
  options?: MediaUrlGuardOptions,
): URL | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MEDIA_URL_MAX_CHARS) return null;
  if (UNSAFE_URL_CHARS_RE.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hash !== "" || url.includes("#")) return null;
  if (normalizeOrigins(options?.exactOrigins).has(parsed.origin)) return parsed;
  if (parsed.protocol !== "https:" || parsed.port !== "") return null;
  const host = parsed.hostname;
  if (host === "" || host.endsWith(".") || isIpLiteralHost(host)) return null;
  for (const raw of hostSuffixes) {
    const suffix = normalizeSuffix(raw);
    if (suffix !== null && (host === suffix || host.endsWith(`.${suffix}`))) return parsed;
  }
  return null;
}

/** `parseAllowedMediaUrl(url, hostSuffixes, options) !== null`. */
export function isAllowedMediaUrl(
  url: string,
  hostSuffixes: readonly string[],
  options?: MediaUrlGuardOptions,
): boolean {
  return parseAllowedMediaUrl(url, hostSuffixes, options) !== null;
}

export interface MediaRedirectOptions extends MediaUrlGuardOptions {
  /**
   * `true` (default): the redirect must stay on the current URL's host ("no redirects to other
   * hosts"). `false`: any host the guard allows. Either way the target passes
   * `parseAllowedMediaUrl` (https, allow-listed, no user-info, no IP literal).
   */
  readonly sameHost?: boolean;
}

/**
 * Target of a 3xx `Location` header (relative or absolute) seen while downloading `from`, or
 * `null` when it must not be followed (missing, unparsable, another host, or not an allowed media
 * URL). Callers count hops against `IMPORT_MEDIA_MAX_REDIRECTS`.
 */
export function resolveMediaRedirect(
  from: string | URL,
  location: string | null | undefined,
  hostSuffixes: readonly string[],
  options?: MediaRedirectOptions,
): URL | null {
  if (typeof location !== "string" || location.length === 0) return null;
  if (location.length > MEDIA_URL_MAX_CHARS || UNSAFE_URL_CHARS_RE.test(location)) return null;
  let base: URL;
  let target: URL;
  try {
    base = new URL(from);
    target = new URL(location, base);
  } catch {
    return null;
  }
  if ((options?.sameHost ?? true) && target.host !== base.host) return null;
  return parseAllowedMediaUrl(target.href, hostSuffixes, options);
}
