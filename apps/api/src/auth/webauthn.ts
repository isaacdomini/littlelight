import {
  authenticatorDataHasUserVerification,
  PASSKEY_FAILED_MESSAGE,
  PASSKEY_MAX_PER_USER,
  type PasskeyLimitDetails,
} from "@tinyglow/shared";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, notFound, safeErrorLog } from "../lib/errors";
import { GoTrueError } from "./gotrue";

// Passkey helpers shared by the public sign-in routes (routes.ts) and the management routes
// (passkeys.ts) (docs/plans/step-13.md 2.4, 5.1 D3/D6; decisions b and g). No network, no
// database. The only WebAuthn parsing the API ever does is reading the authenticator-data flags
// byte: GoTrue asks for user verification as `preferred` only, so the API refuses any assertion or
// attestation whose UV bit is clear BEFORE forwarding it. That check is what makes a passkey
// sign-in count as a fresh, user-verified sign-in (Q5). Nothing decoded here is kept or logged.

/** 404 `passkey_disabled`: `AUTH_PASSKEYS_ENABLED=false` (every passkey route, before validation). */
export const passkeyDisabled = () =>
  new ApiError(404, "passkey_disabled", "Passkeys aren't available on this server");

/** 401 `passkey_failed`: the one answer for every verify-time problem (D3). */
export const passkeyFailed = () => new ApiError(401, "passkey_failed", PASSKEY_FAILED_MESSAGE);

/** 409 `passkey_limit` with `details: { max }`. */
export const passkeyLimit = () =>
  new ApiError(
    409,
    "passkey_limit",
    `You can have at most ${PASSKEY_MAX_PER_USER} passkeys. Remove one to add another.`,
    { max: PASSKEY_MAX_PER_USER } satisfies PasskeyLimitDetails,
  );

/** 409 `passkey_exists`: this authenticator credential is already registered. */
export const passkeyExists = () =>
  new ApiError(409, "passkey_exists", "This passkey is already added to your account");

/** 403 `passkey_unavailable_for_account`: the store-review account (Q6). */
export const passkeyUnavailableForAccount = () =>
  new ApiError(
    403,
    "passkey_unavailable_for_account",
    "Passkeys aren't available for this account",
  );

/** 503: GoTrue down, timed out, answered 5xx or an unparseable body. Same text as the OTP path. */
export const passkeyUpstreamUnavailable = () =>
  new ApiError(503, "internal", "Sign-in is temporarily unavailable, try again shortly");

// Control characters, DEL/C1, and the Unicode line/paragraph separators (U+2028/U+2029),
// written as escape sequences so no raw line terminator sits in the source.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * 400 `validation_failed` naming `body.name` when a passkey name holds control or line-break
 * characters (the shared schema already trims and bounds the length). The value is never echoed.
 */
export function assertPasskeyNameShape(name: string): void {
  if (CONTROL_CHAR_RE.test(name)) {
    throw new ApiError(400, "validation_failed", "The passkey name is invalid", {
      fields: ["body.name"],
    });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode a base64url field (unpadded as WebAuthn emits it; `=` padding tolerated). Node's
 * `base64url` decoder also accepts the standard alphabet, which is fine: the shared schema has
 * already bounded the character set and length.
 */
function decodeBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/**
 * The one part of a credential the UV checks read. Structural, so both the parsed
 * `PublicKeyCredentialJson` and its pre-default input shape (tests, native plugins) fit.
 */
export interface CredentialForUvCheck {
  response: {
    authenticatorData?: string | null;
    attestationObject?: string | null;
  };
}

/**
 * True when an assertion (`navigator.credentials.get`) carries authenticator data with the UV
 * flag set. A missing `authenticatorData`, a short blob or a clear flag ⇒ false.
 */
export function assertionHasUserVerification(credential: CredentialForUvCheck): boolean {
  const raw = credential.response.authenticatorData;
  if (!raw) return false;
  return authenticatorDataHasUserVerification(decodeBase64url(raw));
}

/**
 * True when a registration (`navigator.credentials.create`) carries an attestation object whose
 * `authData` has the UV flag set. Only the CBOR map's `authData` entry is located (definite
 * lengths only, as WebAuthn's CTAP2 canonical CBOR requires); the attestation statement is never
 * interpreted. Anything malformed ⇒ false.
 */
export function attestationHasUserVerification(credential: CredentialForUvCheck): boolean {
  const raw = credential.response.attestationObject;
  if (!raw) return false;
  const authData = cborMapBytes(decodeBase64url(raw), "authData");
  return authData !== null && authenticatorDataHasUserVerification(authData);
}

// ---------------------------------------------------------------------------------------------
// Minimal CBOR walker (RFC 8949): enough to find one byte-string value by text key in a top-level
// map. Definite lengths only; indefinite lengths, reserved additional-info values, 64-bit lengths
// above 2^32 and nesting deeper than `MAX_DEPTH` all fail (return null). Every read is
// bounds-checked against the buffer, so a hostile body can at worst be refused.
// ---------------------------------------------------------------------------------------------

const MAX_DEPTH = 8;
const MAX_CONTAINER_ITEMS = 1 << 16;

interface Head {
  major: number;
  info: number;
  /** Argument value (length, count, integer or simple value), or -1 when none is encoded. */
  value: number;
  /** Offset of the first byte after the head. */
  next: number;
}

function readHead(buf: Uint8Array, pos: number): Head | null {
  if (pos >= buf.length) return null;
  const b = buf[pos] as number;
  const major = b >> 5;
  const info = b & 0x1f;
  if (info < 24) return { major, info, value: info, next: pos + 1 };
  let n: number;
  switch (info) {
    case 24:
      n = 1;
      break;
    case 25:
      n = 2;
      break;
    case 26:
      n = 4;
      break;
    case 27:
      n = 8;
      break;
    default:
      // 28–30 reserved, 31 indefinite length: not canonical CBOR.
      return null;
  }
  if (pos + 1 + n > buf.length) return null;
  let value = 0;
  for (let i = 0; i < n; i++) {
    const byte = buf[pos + 1 + i] as number;
    // 8-byte arguments: refuse anything that does not fit in a safe 32-bit length.
    if (n === 8 && i < 4 && byte !== 0) return null;
    value = value * 256 + byte;
  }
  return { major, info, value, next: pos + 1 + n };
}

/** Offset just past the item starting at `pos`, or -1 when malformed. */
function skipItem(buf: Uint8Array, pos: number, depth: number): number {
  if (depth > MAX_DEPTH) return -1;
  const h = readHead(buf, pos);
  if (!h) return -1;
  switch (h.major) {
    case 0: // unsigned int
    case 1: // negative int
      return h.next;
    case 2: // byte string
    case 3: {
      // text string
      const end = h.next + h.value;
      return end <= buf.length ? end : -1;
    }
    case 4: // array
    case 5: {
      // map
      const items = h.major === 5 ? h.value * 2 : h.value;
      if (items > MAX_CONTAINER_ITEMS) return -1;
      let p = h.next;
      for (let i = 0; i < items; i++) {
        p = skipItem(buf, p, depth + 1);
        if (p < 0) return -1;
      }
      return p;
    }
    case 6: // tag
      return skipItem(buf, h.next, depth + 1);
    default: {
      // 7: floats / simple values; the argument bytes (if any) were consumed by readHead.
      return h.next <= buf.length ? h.next : -1;
    }
  }
}

/**
 * The byte-string value stored under text key `key` in the top-level CBOR map of `buf`, or null
 * when `buf` is not a map, the key is absent, the value is not a byte string, or anything is
 * malformed.
 */
export function cborMapBytes(buf: Uint8Array, key: string): Uint8Array | null {
  const head = readHead(buf, 0);
  if (head?.major !== 5) return null;
  if (head.value > MAX_CONTAINER_ITEMS) return null;
  const wanted = new TextEncoder().encode(key);
  let p = head.next;
  for (let i = 0; i < head.value; i++) {
    const k = readHead(buf, p);
    if (!k) return null;
    let matches = false;
    if (k.major === 3) {
      const end = k.next + k.value;
      if (end > buf.length) return null;
      if (k.value === wanted.length) {
        matches = true;
        for (let j = 0; j < wanted.length; j++) {
          if (buf[k.next + j] !== wanted[j]) {
            matches = false;
            break;
          }
        }
      }
    }
    const valuePos = skipItem(buf, p, 1);
    if (valuePos < 0) return null;
    if (matches) {
      const v = readHead(buf, valuePos);
      if (v?.major !== 2) return null;
      const end = v.next + v.value;
      if (end > buf.length) return null;
      return buf.subarray(v.next, end);
    }
    p = skipItem(buf, valuePos, 1);
    if (p < 0) return null;
  }
  return null;
}

/** Where a GoTrue passkey failure happened; only `manage` maps a 404 `validation_failed` to `not_found`. */
export type PasskeyErrorContext = "sign_in" | "register" | "manage";

/** 429 `rate_limited` relaying GoTrue's own limiter (`/passkeys/authentication/options`, 30 / 5 min per IP). */
export const passkeyUpstreamRateLimited = (retryAfterSec: number | undefined) =>
  new ApiError(
    429,
    "rate_limited",
    "Too many attempts, try again later",
    undefined,
    retryAfterSec === undefined ? undefined : { retryAfterSec },
  );

/**
 * Map a GoTrue failure on a passkey route to the API error (docs/plans/step-13.md 2.4, decision
 * b), logging status + `error_code` only (never a body). 429 (`over_request_rate_limit`, GoTrue's
 * limiter on the options route) → 429 `rate_limited`, with `Retry-After` when GoTrue sent one.
 * Other 4xx: `passkey_disabled` → 404; `too_many_passkeys` → 409 `passkey_limit`;
 * `webauthn_credential_exists` → 409 `passkey_exists`; a 404 `validation_failed` on rename/delete
 * → 404 `not_found`; every other 4xx (unknown credential, bad signature, expired/used challenge,
 * bad body, unconfirmed email, banned user, `insufficient_aal`) → the one generic 401
 * `passkey_failed`. 5xx, transport failures and unparseable bodies → 503 (the OTP path's rule; it
 * reveals nothing about a credential).
 */
export function mapPasskeyError(
  err: unknown,
  log: Pick<FastifyBaseLogger, "warn" | "error">,
  context: PasskeyErrorContext,
): ApiError {
  if (err instanceof GoTrueError) {
    if (err.status === 429) {
      log.warn(
        { status: err.status, code: err.code, context },
        "gotrue rate-limited a passkey call",
      );
      return passkeyUpstreamRateLimited(err.retryAfterSec);
    }
    if (err.isClientError) {
      log.warn({ status: err.status, code: err.code, context }, "gotrue refused a passkey call");
      switch (err.code) {
        case "passkey_disabled":
          return passkeyDisabled();
        case "too_many_passkeys":
          return passkeyLimit();
        case "webauthn_credential_exists":
          return passkeyExists();
        case "validation_failed":
          if (err.status === 404 && context === "manage") return notFound("No such passkey");
          return passkeyFailed();
        default:
          return passkeyFailed();
      }
    }
    log.warn({ status: err.status, code: err.code, context }, "gotrue unavailable");
    return passkeyUpstreamUnavailable();
  }
  log.error({ err: safeErrorLog(err), context }, "gotrue passkey call failed");
  return passkeyUpstreamUnavailable();
}

/** A passkey id from the route params; GoTrue's ids are UUIDs, anything else is `not_found`. */
export function assertPasskeyId(id: string): void {
  if (!UUID_RE.test(id)) throw notFound("No such passkey");
}
