import { SHARE_PATH } from "./constants";

// Telemetry scrubbing (docs/plans/review-fixes.md 2.2, 2.6, D8; PRD "Observability", CLAUDE.md
// "Never log photo bytes, GPS, or prompts containing parent notes"). Pure, browser-safe, no
// dependencies: used as Sentry's `beforeSend` by the api, the worker and the web build, and by the
// api's request logger (`redactUrl`).
//
// Defence in depth. The Sentry clients run with default integrations off, so events should only
// ever hold an exception (type, message, frames) and a few tags. This scrubber still assumes any
// field may carry user data and:
// 1. deletes whole sections that describe the request or the user (`request`, `user`,
//    `breadcrumbs`, `extra`, `server_name`, `transaction`, `contexts.{culture,device,app}`);
// 2. drops, at any depth, every key whose name says it holds credentials, request data, contact
//    data, coordinates, parent text or model prompts (`SENSITIVE_KEYS`; e.g. `cookies`,
//    `headers`, `body`, `data`, `vars`, `token`, `email`, `lat`, `note`, `prompt`, `messages`);
// 3. rewrites every remaining string: JWTs, Bearer/Basic credentials, `X-Amz-*` and other
//    signature parameters, secret `key=value` pairs, URL user-info, query strings and fragments,
//    invite/share path segments, emails, coordinates, Postgres row details and token-shaped runs
//    are replaced, and so are (step 10, photo import) Google OAuth tokens and codes, the fake
//    Picker's token shapes, Google media / Picker URLs, OAuth `code=`/`state=` pairs, native
//    upload-cache, share-staging and album-sync paths, photo-library paths and PHAsset
//    identifiers, and (step 12, video) worker scratch paths, QuickTime location tags and ISO 6709
//    coordinate strings; strings are capped at `TELEMETRY_MAX_STRING_CHARS`;
// 4. walks at most `TELEMETRY_MAX_DEPTH` levels (deeper values become a marker), caps arrays and
//    objects, cuts cycles, and copies: the input is never mutated.
// The output of `scrubTelemetryEvent` is stable under a second pass (idempotent).

/** Replacement for a removed value or segment. */
export const REDACTED = "[redacted]";
/** Longest string kept in an event (after scrubbing), marker included. */
export const TELEMETRY_MAX_STRING_CHARS = 2000;
/** Nesting levels walked below the event root; deeper values become `[depth]`. */
export const TELEMETRY_MAX_DEPTH = 10;
/** Items kept per array and keys kept per object. */
export const TELEMETRY_MAX_ITEMS = 250;
/** Values visited per event; the rest become `[limit]` (bounds work on shared references). */
export const TELEMETRY_MAX_NODES = 10_000;

const TRUNCATED = "…[truncated]";
const DEPTH_MARKER = "[depth]";
const CIRCULAR_MARKER = "[circular]";
const LIMIT_MARKER = "[limit]";
/** Strings longer than this are cut before scrubbing (bounds regex work); see `scrubString`. */
const PRE_CUT_CHARS = TELEMETRY_MAX_STRING_CHARS * 8;

// ---------------------------------------------------------------------------------------------
// URL path redaction (moved from apps/api/src/app.ts; the api re-exports `redactUrl` for its
// request logger, so logs and telemetry apply one set of rules)
// ---------------------------------------------------------------------------------------------

/**
 * A path segment that looks like a bearer token (invite tokens are 43-char base64url, share
 * tokens 22: `SHARE_TOKEN_LENGTH`). UUIDs are identifiers, not secrets, and stay readable.
 */
export const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{22,}$/;
/** A UUID path segment (kept by every redaction rule). */
export const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The only literal segments of the viewer routes (`/share/*`, docs/plans/step-8.md 2.6). Anything
 * else under `/share/` that is not a UUID is redacted: no viewer route takes a token in its path,
 * so a token there is a client mistake that must still never reach a log or an event.
 */
export const SHARE_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "session",
  "album",
  "photos",
  "urls",
  "download",
  "manifest.webmanifest",
]);
/**
 * Path segments whose next segment is always a secret: `/invites/<token>`, SPA `/s/<token>`, and
 * a Picker session in a `pickerUri` (`/picker/<session>`, Google's and the fake's; step 10).
 */
const SECRET_NEXT_SEGMENT: ReadonlySet<string> = new Set([
  "invites",
  SHARE_PATH.slice(1),
  "picker",
]);

/** Applies the path rules of `redactUrl` to a path without query string. */
function redactPathSegments(path: string): string {
  const parts = path.split("/");
  const shareAt = parts[1] === "api" ? 2 : 1;
  const underShare = parts[shareAt] === "share";
  return parts
    .map((seg, i, all) => {
      if (seg === "") return seg;
      if (i > 0 && SECRET_NEXT_SEGMENT.has(all[i - 1] ?? "")) return REDACTED;
      if (
        underShare &&
        i > shareAt &&
        !SHARE_ROUTE_SEGMENTS.has(seg) &&
        !UUID_SEGMENT_RE.test(seg)
      ) {
        return REDACTED;
      }
      if (TOKEN_SEGMENT_RE.test(seg) && !UUID_SEGMENT_RE.test(seg)) return REDACTED;
      return seg;
    })
    .join("/");
}

/**
 * URL as logged: query strings dropped (they can carry codes, and the viewer manifest's `?t=`
 * share token), the segment after `/invites/` or `/s/` (SPA share link) replaced, every segment
 * under `/share/` except the route's own words and UUIDs replaced, and any token-shaped segment
 * replaced. Works with and without the browser-facing `/api` prefix. Takes a path (+ query), as
 * Fastify's `request.url`; absolute URLs inside free text go through `scrubTelemetryString`.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  return redactPathSegments(path) + (q === -1 ? "" : `?${REDACTED}`);
}

// ---------------------------------------------------------------------------------------------
// String patterns
// ---------------------------------------------------------------------------------------------

/**
 * Every pattern the string scrubber applies, by name (no `g` flag: safe for `.test()` in tests;
 * the scrubber builds global copies). Order of application is `STRING_RULES` below.
 */
export const TELEMETRY_SCRUB_PATTERNS = Object.freeze({
  /** A JWT (GoTrue access token, viewer JWT, id token): `eyJ<header>.<payload>.<signature>`. */
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /** A Google OAuth access token: `ya29.<base64url>` (photo import, docs/plans/step-10.md 2.3). */
  googleAccessToken: /\bya29\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/,
  /** A Google OAuth refresh token: `1//<base64url>`. */
  googleRefreshToken: /\b1\/\/[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/,
  /** A Google OAuth authorization code: `4/0<base64url>`. */
  googleAuthCode: /\b4\/[0-9A-Za-z_-]{10,}(?:\.[A-Za-z0-9_-]+)*/,
  /** The fake Picker server's tokens and codes: `fake-access-…`, `fake-refresh-…`, `fake-code-…`. */
  fakeGoogleToken: /\bfake-(?:access|refresh|code)-[A-Za-z0-9_-]+/,
  /**
   * A Google media URL tail (a Picker `baseUrl`, with or without `=d`/size params): group 1 is
   * the host (`lh3.googleusercontent.com`), kept; the path is replaced.
   */
  googleMediaUrl: /\b((?:[A-Za-z0-9-]+\.)*googleusercontent\.com)\/(?!\[)[^\s"'<>()[\]{}]+/i,
  /**
   * A Picker session/media-items URL or a `pickerUri` tail: group 1 is the host and fixed path,
   * group 2 the separator (`/` or `?`), both kept; the session id / query is replaced.
   */
  googlePickerUrl:
    /\b(photospicker\.googleapis\.com\/v1\/(?:sessions|mediaItems)|photos\.google\.com\/picker)([/?])(?!\[)[^\s"'<>()[\]{}]+/i,
  /**
   * A file in a native app directory: the upload cache (`Caches/ll-uploads/<uuid>.heic`), the
   * share-extension staging area (`ll-share/`), Apple album sync exports (`Caches/ll-sync-export/`)
   * and the sync ledger (`Application Support/ll-sync/<sha256(albumId)>.json`). Group 1 (the
   * directory name) is kept; the rest of the path is replaced.
   */
  nativeUploadPath: /\b(ll-uploads|ll-share|ll-sync-export|ll-sync)\/(?!\[)[^\s"'<>()[\]{}]+/,
  /** A file in the iOS photo library (`/var/mobile/Media/DCIM/…`): group 1 kept. */
  photoLibraryPath: /(\/var\/mobile\/Media)\/(?!\[)[^\s"'<>()[\]{}]+/,
  /** A PHAsset local identifier (`<UUID>/L0/001`): never leaves the device (D3). */
  phAssetId: /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\/L0\/\d{3}\b/i,
  /**
   * A file under the worker's video scratch folder (`/scratch/<photoId>.orig`, `/scratch/…/web.mp4`;
   * docs/plans/step-12.md 2.3, Q8): group 1 (the folder) is kept, the rest of the path replaced.
   */
  scratchPath: /(\/scratch)\/(?!\[)[^\s"'<>()[\]{}]+/,
  /**
   * A QuickTime location tag with whatever follows it (`com.apple.quicktime.location.ISO6709=+47.6-122.3/`,
   * `com.apple.quicktime.location.accuracy.horizontal: 5`): the key is kept, the value replaced.
   */
  quicktimeLocationTag: /\bcom\.apple\.quicktime\.location(?!\[)[^\s"'<>()[\]{}]*/,
  /**
   * An ISO 6709 coordinate string as QuickTime writes it: `±DD.DDDD±DDD.DDDD[±AAA.AAA]/`
   * (latitude, longitude, optional altitude).
   */
  iso6709: /[+-]\d{2}\.\d+[+-]\d{3}\.\d+(?:[+-]\d+(?:\.\d+)?)?\/?/,
  /** `Authorization` credentials written out: `Bearer <token>`, `Basic <base64>`. */
  authCredential: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /**
   * WebAuthn material written as `key=value` / `key: value` / `"key":"value"` (step 13,
   * docs/plans/step-13.md 2.3): `clientDataJSON`, `attestationObject`, `authenticatorData`,
   * `signature`, `rawId`, `userHandle`, `challenge`, `challenge_id` / `challengeId`. Group 1 (the
   * key) and 2 (the separator) are kept; the value is replaced.
   */
  webauthnPair:
    /\b(clientDataJSON|attestationObject|authenticatorData|signature|rawId|userHandle|challenge(?:_?id)?)(["']?\s*[:=]\s*["']?)(?!\[)[^\s"'&,;)}\]]+/i,
  /** Presigned-URL parameters: `X-Amz-Signature=…`, `X-Amz-Credential=…`, SigV2 `Signature=…`. */
  amzParam: /\b(X-Amz-[A-Za-z-]+|AWSAccessKeyId|Signature|Credential)=[^&\s"'<>]+/i,
  /**
   * Secret `key=value` / `key: value` / `"key":"value"` pairs whose key ends in token,
   * token_hash, passcode, password, secret, api_key or otp (`pushToken=…`, `refresh_token: …`).
   */
  secretPair:
    /\b([A-Za-z0-9_-]{0,40}?(?:token(?:_?hash)?|passcode|password|passwd|secret|api_?key|otp))(["']?\s*[:=]\s*["']?)(?!\[)[^\s"'&,;)}\]]+/i,
  /**
   * A URL or path: optional `scheme://authority`, then a `/`-path with optional query and
   * fragment. The replacer drops user-info, query and fragment and applies the `redactUrl` path
   * rules (invite/share segments).
   */
  urlOrPath:
    /(?:\b[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s/?#"'<>()[\]{}]*)?\/[^\s?#"'<>()[\]{}]*(?:[?#](?!\[redacted\])[^\s"'<>(){}]*)?/,
  /**
   * A query string or fragment glued to a word (`callback?code=…`, `x#token_hash=…`) outside a
   * path; group 1 is the character before it (no lookbehind: iOS 15 WebViews lack it).
   */
  queryOrFragment: /([A-Za-z0-9_.\-\]])([?#])(?!\[redacted\])[^\s"'<>(){}]+/,
  /** An OAuth `code=…` or `state=…` parameter outside a URL (`code=4/0A… state=eyJ…`). */
  oauthParam: /\b(code|state)=(?!\[)[^\s"'&,;)}\]]+/,
  /** An email address, also masked ones (`m***@gmail.com`, `maskEmail`; step 11). */
  email: /[A-Za-z0-9._%+*-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/,
  /** A decimal coordinate pair: `47.6062, -122.3321`. */
  coordinatePair: /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/,
  /** A WKT point: `POINT(-122.3321 47.6062)`. */
  wktPoint: /\bPOINT\s*\(\s*-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s*\)/i,
  /** A labelled coordinate: `lat=47.6`, `"lng": -122.3`, `latitude: 47.6`. */
  labelledCoordinate:
    /\b(lat|lng|lon|long|latitude|longitude|gps_lat|gps_lng|home_lat|home_lng)(["']?\s*[:=]\s*["']?)-?\d+(?:\.\d+)?/i,
  /** Postgres error details that echo row values: `Failing row contains (…)`, `Key (col)=(…)`. */
  pgRowDetail: /(Failing row contains|Key \([^)\n]*\)=)(\s*)\([^\n]*\)/,
  /**
   * A token-shaped run of 22+ base64url characters (share/invite tokens, push tokens, hex
   * digests, signatures). UUIDs and word-like identifiers (`processTicksAndRejections`) are kept
   * by the replacer (`isTokenLike`).
   */
  tokenRun: /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{22,})(?![A-Za-z0-9_-])/,
} as const);

export type TelemetryScrubPattern = keyof typeof TELEMETRY_SCRUB_PATTERNS;

const P = TELEMETRY_SCRUB_PATTERNS;
const withGlobalFlag = (re: RegExp) =>
  new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

/** A camelCase / snake / kebab identifier piece: `process`, `Ticks`, `HTTP`. */
const WORD_PIECE_RE = /[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]{2,}/g;

/** Shortest average word length of an identifier-like run (`FST_ERR_CTP_INVALID_MEDIA_TYPE`: 4.2). */
const MIN_AVERAGE_WORD_LETTERS = 3.6;
/** A lower-case word piece of 4+ letters with no vowel (`Qpfbf`, `xkzq`): not a real word. */
const VOWELLESS_PIECE_RE = /^[A-Z]?[b-df-hj-np-tv-xz]{4,}$/;

/**
 * True for a run that should be redacted: not a UUID, and either it contains a digit or it is
 * not built from identifier words (`processTicksAndRejections`, `FST_ERR_CTP_INVALID_MEDIA_TYPE`
 * are kept). A random 22-char base64url token contains a digit with ~98 % probability; without
 * one, its isolated letters, vowel-less pieces or short average word length fail the word test.
 * Measured on random tokens standing alone in free text: 22-char share tokens slip through about
 * 1 in 10,000 times, 43-char invite tokens 0 in 200,000. Path contexts (`/s/<token>`,
 * `/invites/<token>`, `/share/…`) and query strings are always redacted by the URL rules.
 */
function isTokenLike(run: string): boolean {
  if (UUID_SEGMENT_RE.test(run)) return false;
  if (/[0-9]/.test(run)) return true;
  let letters = 0;
  let pieceCount = 0;
  for (const chunk of run.split(/[_-]+/)) {
    if (chunk === "") continue;
    const pieces = chunk.match(WORD_PIECE_RE) ?? [];
    if (pieces.join("") !== chunk) return true;
    if (pieces.some((piece) => VOWELLESS_PIECE_RE.test(piece))) return true;
    letters += chunk.length;
    pieceCount += pieces.length;
  }
  // Identifiers are made of words (4+ letters on average); random strings of many short pieces.
  return pieceCount > 0 && letters / pieceCount < MIN_AVERAGE_WORD_LETTERS;
}

function scrubUrlOrPath(match: string): string {
  let rest = match;
  let prefix = "";
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\//.exec(rest);
  if (scheme) {
    const afterScheme = rest.slice(scheme[0].length);
    const slash = afterScheme.indexOf("/");
    const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
    const at = authority.lastIndexOf("@");
    prefix = scheme[0] + (at === -1 ? authority : `${REDACTED}@${authority.slice(at + 1)}`);
    rest = slash === -1 ? "" : afterScheme.slice(slash);
  }
  const cut = rest.search(/[?#]/);
  const path = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? "" : `${rest[cut]}${REDACTED}`;
  return prefix + redactPathSegments(path) + tail;
}

type Replacer = (match: string, ...groups: string[]) => string;

/**
 * Applied in this order; each output is stable under every rule (idempotence). URLs go before
 * emails so user-info (`user:pass@host`) is removed as a whole.
 */
const STRING_RULES: ReadonlyArray<readonly [RegExp, Replacer]> = [
  [withGlobalFlag(P.jwt), () => "[jwt]"],
  [withGlobalFlag(P.googleAccessToken), () => REDACTED],
  [withGlobalFlag(P.googleRefreshToken), () => REDACTED],
  [withGlobalFlag(P.googleAuthCode), () => REDACTED],
  [withGlobalFlag(P.fakeGoogleToken), () => REDACTED],
  [withGlobalFlag(P.googleMediaUrl), (_m, host) => `${host}/${REDACTED}`],
  [withGlobalFlag(P.googlePickerUrl), (_m, lead, sep) => `${lead}${sep}${REDACTED}`],
  [withGlobalFlag(P.nativeUploadPath), (_m, dir) => `${dir}/${REDACTED}`],
  [withGlobalFlag(P.photoLibraryPath), (_m, dir) => `${dir}/${REDACTED}`],
  [withGlobalFlag(P.phAssetId), () => "[asset-id]"],
  [withGlobalFlag(P.scratchPath), (_m, dir) => `${dir}/${REDACTED}`],
  [withGlobalFlag(P.quicktimeLocationTag), () => `com.apple.quicktime.location${REDACTED}`],
  [withGlobalFlag(P.iso6709), () => "[coords]"],
  [withGlobalFlag(P.authCredential), (_m, scheme) => `${scheme} ${REDACTED}`],
  [withGlobalFlag(P.webauthnPair), (_m, key, sep) => `${key}${sep}${REDACTED}`],
  [withGlobalFlag(P.amzParam), (_m, name) => `${name}=${REDACTED}`],
  [withGlobalFlag(P.secretPair), (_m, key, sep) => `${key}${sep}${REDACTED}`],
  [withGlobalFlag(P.pgRowDetail), (_m, lead, space) => `${lead}${space}(${REDACTED})`],
  [withGlobalFlag(P.wktPoint), () => "POINT([coords])"],
  [withGlobalFlag(P.coordinatePair), () => "[coords]"],
  [withGlobalFlag(P.labelledCoordinate), (_m, key, sep) => `${key}${sep}${REDACTED}`],
  [withGlobalFlag(P.urlOrPath), (m) => scrubUrlOrPath(m)],
  [withGlobalFlag(P.queryOrFragment), (_m, before, mark) => `${before}${mark}${REDACTED}`],
  [withGlobalFlag(P.oauthParam), (_m, key) => `${key}=${REDACTED}`],
  [withGlobalFlag(P.email), () => "[email]"],
  [withGlobalFlag(P.tokenRun), (m, before, run) => (isTokenLike(run) ? `${before}${REDACTED}` : m)],
];

/** `s` without its trailing run of non-whitespace characters (linear; a regex `\S*$` is not). */
function dropTrailingRun(s: string): string {
  let end = s.length;
  while (end > 0 && !/\s/.test(s.charAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

/**
 * Scrubs one string (rules of `TELEMETRY_SCRUB_PATTERNS`) and caps it at
 * `TELEMETRY_MAX_STRING_CHARS`. Pure and idempotent.
 */
export function scrubTelemetryString(value: string): string {
  let s = value;
  const preCut = s.length > PRE_CUT_CHARS;
  if (preCut) {
    // Drop the tail and the run it was cut in, so a token split at the cut cannot survive as a
    // shorter, no longer token-shaped fragment.
    s = dropTrailingRun(s.slice(0, PRE_CUT_CHARS));
  }
  for (const [re, replacer] of STRING_RULES) {
    s = s.replace(re, replacer);
  }
  if (preCut || s.length > TELEMETRY_MAX_STRING_CHARS) {
    s = dropTrailingRun(s.slice(0, TELEMETRY_MAX_STRING_CHARS - TRUNCATED.length)) + TRUNCATED;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Event walking
// ---------------------------------------------------------------------------------------------

/**
 * Keys dropped at any depth, compared lower-case with `_`, `-`, `.` and spaces removed
 * (`set-cookie`, `X-Api-Key`, `gps_lat`, `ipAddress` all match).
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Request data, credentials, session material.
  "request",
  "breadcrumbs",
  "extra",
  "servername",
  "transaction",
  "culture",
  "device",
  "token",
  "tokens",
  "headers",
  "cookie",
  "cookies",
  "setcookie",
  "authorization",
  "proxyauthorization",
  "body",
  "data",
  "querystring",
  "query",
  "params",
  "form",
  "env",
  "vars",
  "password",
  "passcode",
  "secret",
  "otp",
  "apikey",
  "xapikey",
  "dsn",
  "signature",
  "credential",
  "credentials",
  "signedurl",
  // Passkeys (step 13): WebAuthn credential material and challenge ids (`credential`, `signature` above).
  "clientdatajson",
  "attestationobject",
  "authenticatordata",
  "rawid",
  "userhandle",
  "challenge",
  "challengeid",
  "publickey",
  "credentialid",
  // Photo import (step 10): Google capabilities and identifiers, device-only identifiers, parent text.
  "baseurl",
  "pickeruri",
  "mediaurl",
  "downloadurl",
  "providersessionid",
  "provideritemid",
  "refreshtokenenc",
  "localidentifier",
  "assetid",
  "assetids",
  "albumid",
  "albumtitle",
  "devicelabel",
  // Identity and contact data.
  "user",
  "email",
  "emails",
  "ip",
  "ipaddress",
  "clientip",
  "remoteaddress",
  "xforwardedfor",
  "cfconnectingip",
  // Family-start safeguards (step 11): HMAC'd IPs, canonical and masked addresses.
  "iphash",
  "emailcanonical",
  "canonicalemail",
  "existingemailmasked",
  "phone",
  "displayname",
  "babyname",
  "nickname",
  // Coordinates and places.
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "gps",
  "gpslat",
  "gpslng",
  "homelat",
  "homelng",
  "coords",
  "coordinates",
  "location",
  "locationlabel",
  "placelabel",
  "homelabel",
  "exif",
  "rawjson",
  "raw",
  // Video (step 12): the QuickTime location tag's value key as ffprobe spells it.
  "iso6709",
  // Parent text and model traffic.
  "note",
  "notes",
  "caption",
  "description",
  "detaileddescription",
  "searchtags",
  "people",
  "prompt",
  "prompts",
  "systemprompt",
  "instructions",
  "input",
  "messages",
  "content",
  "text",
  "question",
  "answer",
  "q",
]);

/** Key-name suffixes dropped at any depth (`pushToken`, `ownerEmail`, `refresh_token`, …). */
const SENSITIVE_KEY_SUFFIXES: readonly string[] = [
  "token",
  "tokens",
  "password",
  "passcode",
  "secret",
  "cookie",
  "email",
  "apikey",
  "authorization",
  "latitude",
  "longitude",
  "prompt",
];

/** Top-level event sections deleted outright. */
const DROPPED_EVENT_KEYS: readonly string[] = [
  "request",
  "user",
  "breadcrumbs",
  "extra",
  "server_name",
  "transaction",
];
/** `contexts.*` sections deleted outright (locale/time zone, device, app memory and start time). */
const DROPPED_CONTEXTS: readonly string[] = ["culture", "device", "app"];

/** Sentry ids kept verbatim when they have their documented shape (hex or uuid). */
const ID_KEYS: ReadonlySet<string> = new Set([
  "event_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "debug_id",
]);
const ID_VALUE_RE =
  /^[0-9a-f]{16,32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]+/g, "");
}

function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  if (SENSITIVE_KEYS.has(k)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => k.length > suffix.length && k.endsWith(suffix));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface WalkState {
  /** Objects on the current path (cycle detection). */
  readonly ancestors: WeakSet<object>;
  /** Values visited so far. */
  nodes: number;
}

function scrubValue(value: unknown, depth: number, state: WalkState): unknown {
  state.nodes += 1;
  if (state.nodes > TELEMETRY_MAX_NODES) return LIMIT_MARKER;
  switch (typeof value) {
    case "string":
      return scrubTelemetryString(value);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  const obj = value as object;
  if (depth >= TELEMETRY_MAX_DEPTH) return DEPTH_MARKER;
  if (state.ancestors.has(obj)) return CIRCULAR_MARKER;
  state.ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      for (const item of obj.slice(0, TELEMETRY_MAX_ITEMS)) {
        const v = scrubValue(item, depth + 1, state);
        out.push(v === undefined ? null : v);
      }
      return out;
    }
    if (obj instanceof Date) {
      return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    }
    if (obj instanceof Error) {
      return {
        name: scrubTelemetryString(String(obj.name)),
        message: scrubTelemetryString(String(obj.message)),
      };
    }
    if (!isPlainObject(obj)) return "[object]";
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const key of Object.keys(obj)) {
      if (kept >= TELEMETRY_MAX_ITEMS) break;
      if (isSensitiveKey(key)) continue;
      const raw = obj[key];
      let v: unknown;
      if (ID_KEYS.has(key) && typeof raw === "string" && ID_VALUE_RE.test(raw)) {
        v = raw;
      } else {
        v = scrubValue(raw, depth + 1, state);
      }
      if (v === undefined) continue;
      out[scrubKey(key)] = v;
      kept += 1;
    }
    return out;
  } finally {
    state.ancestors.delete(obj);
  }
}

/** Keys are data too (tag names, header-like maps): scrub them, short and stable. */
function scrubKey(key: string): string {
  const k = key.length > 200 ? key.slice(0, 200) : key;
  return scrubTelemetryString(k);
}

/**
 * Sentry `beforeSend` for every service: returns a scrubbed deep copy of `event` (the input is
 * not mutated). Deletes `request`, `user`, `breadcrumbs`, `extra`, `server_name`, `transaction`
 * and `contexts.{culture,device,app}`; drops sensitive keys at any depth (including every
 * stack frame's `vars`); scrubs every remaining string with `scrubTelemetryString`. A non-object
 * input yields an empty object. Idempotent.
 */
export function scrubTelemetryEvent<T extends object>(event: T): T {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return {} as T;
  const source = event as Record<string, unknown>;
  const top: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (DROPPED_EVENT_KEYS.includes(key)) continue;
    top[key] = source[key];
  }
  const contexts = top.contexts;
  if (contexts !== null && typeof contexts === "object" && !Array.isArray(contexts)) {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(contexts as Record<string, unknown>)) {
      if (!DROPPED_CONTEXTS.includes(k)) kept[k] = v;
    }
    top.contexts = kept;
  }
  // The source counts as an ancestor: a reference back to the event becomes `[circular]` instead
  // of a second copy that still holds the sections dropped above.
  const ancestors = new WeakSet<object>([event]);
  const scrubbed = scrubValue(top, 0, { ancestors, nodes: 0 });
  return (scrubbed !== null && typeof scrubbed === "object" ? scrubbed : {}) as T;
}
