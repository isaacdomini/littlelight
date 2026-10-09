import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  SHARE_LINK_MAX_TTL_HOURS,
  SHARE_PATH,
  SHARE_TOKEN_BYTES,
  userAgentLabel,
  VIEWER_COOKIE_PATH,
  VIEWER_JWT_AUDIENCE,
  type ViewerSessionClaims,
  viewerSessionClaimsSchema,
} from "@littlelight/shared";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import type { ApiConfig } from "../config";

// Share-link secrets (docs/plans/step-8.md 2.2; PRD "Security": share tokens >= 128-bit random,
// stored hashed; "Share-link viewers (no account)"; D1, D7, R2). Everything here is `node:crypto`
// or the existing `jose` (no new dependency). Nothing in this module logs, and no function returns
// or throws anything that contains a token, a hash, a passcode or an IP.
//
// - Token: 16 random bytes, base64url (22 chars). Only `sha256(token)` is stored; the plaintext
//   exists in the create/regenerate response URL and nowhere else (D1). A fast hash is correct for
//   a 128-bit random input.
// - Passcode: exactly 6 digits, stored as `scrypt$1$N$r$p$<salt b64url>$<dk b64url>` (D7),
//   verified in constant time. The 10^6 space is protected by the exchange's persistent rate
//   limits (D8), not by hash cost.
// - Keys: two HKDF-SHA256 derivations of `JWT_SECRET` with distinct `info` strings, so a viewer
//   JWT can never verify as a GoTrue token (different key, issuer and audience) or vice versa
//   (R2), and IP/user-agent hashes are keyed (a database leak cannot brute-force the IPv4 space).

const HKDF_SALT = "littlelight";
const VIEWER_KEY_INFO = "viewer-session-v1";
const IP_KEY_INFO = "share-ip-v1";

/** Allowed clock skew when verifying viewer JWTs, seconds (same as `auth/jwt.ts`). */
export const VIEWER_JWT_CLOCK_TOLERANCE_SEC = 5;

type SecretConfig = Pick<ApiConfig, "JWT_SECRET">;
type IssuerConfig = Pick<ApiConfig, "JWT_SECRET" | "PUBLIC_URL">;

// ---- tokens ---------------------------------------------------------------------------------------

/** A fresh share token (128 bits, base64url) and its SHA-256. Never log either. */
export function newShareToken(): { token: string; hash: Buffer } {
  const token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashShareToken(token) };
}

/** `share_links.token_hash`: SHA-256 of the token's UTF-8 bytes (32 bytes). */
export function hashShareToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** `${PUBLIC_URL}/s/${token}`: returned only by create/regenerate (D1); never logged or stored. */
export function shareLinkUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${SHARE_PATH}/${token}`;
}

// ---- passcodes ------------------------------------------------------------------------------------

const SCRYPT_VERSION = "1";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
/** Bounds accepted when verifying a stored hash (a corrupt row must not become a CPU/memory bomb). */
const SCRYPT_N_MAX = 1 << 17;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const PASSCODE_RE = /^[0-9]{6}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function scryptAsync(
  passcode: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode, salt, keylen, opts, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

/** Hash a 6-digit passcode for `share_links.passcode_hash` (`scrypt$1$N$r$p$salt$dk`). */
export async function hashPasscode(passcode: string): Promise<string> {
  if (!PASSCODE_RE.test(passcode)) throw new RangeError("passcode must be 6 digits");
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const dk = await scryptAsync(passcode, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_VERSION,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    dk.toString("base64url"),
  ].join("$");
}

interface ParsedScrypt {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  dk: Buffer;
}

function parseScryptHash(stored: string): ParsedScrypt | null {
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== SCRYPT_VERSION) return null;
  const [N, r, p] = [Number(parts[2]), Number(parts[3]), Number(parts[4])];
  const saltText = parts[5] ?? "";
  const dkText = parts[6] ?? "";
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) return null;
  if (N > SCRYPT_N_MAX || (N & (N - 1)) !== 0 || r > 32 || p > 16) return null;
  if (!B64URL_RE.test(saltText) || !B64URL_RE.test(dkText)) return null;
  const salt = Buffer.from(saltText, "base64url");
  const dk = Buffer.from(dkText, "base64url");
  if (salt.length < 8 || dk.length < 16 || dk.length > 64) return null;
  return { N, r, p, salt, dk };
}

/**
 * Constant-time check of a passcode against a stored `scrypt$…` hash. `false` for a wrong code
 * and for any hash this API cannot verify (the step-2 `argon2id$` form, a corrupt row): a link
 * whose hash cannot be checked never opens (fail closed).
 */
export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const parsed = parseScryptHash(stored);
  if (!parsed || !PASSCODE_RE.test(passcode)) return false;
  let dk: Buffer;
  try {
    dk = await scryptAsync(passcode, parsed.salt, parsed.dk.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return dk.length === parsed.dk.length && timingSafeEqual(dk, parsed.dk);
}

// ---- derived keys ---------------------------------------------------------------------------------

const keyCache = new Map<string, Uint8Array>();

function deriveKey(config: SecretConfig, info: string): Uint8Array {
  const cacheKey = `${info}\u0000${createHash("sha256").update(config.JWT_SECRET).digest("base64url")}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = new Uint8Array(hkdfSync("sha256", config.JWT_SECRET, HKDF_SALT, info, 32));
  keyCache.set(cacheKey, key);
  return key;
}

/** HS256 key of viewer JWTs: HKDF-SHA256(JWT_SECRET, "littlelight", "viewer-session-v1"). */
export function viewerJwtKey(config: SecretConfig): Uint8Array {
  return deriveKey(config, VIEWER_KEY_INFO);
}

/** HMAC key of IP / user-agent hashes: HKDF-SHA256(JWT_SECRET, "littlelight", "share-ip-v1"). */
export function shareIpKey(config: SecretConfig): Uint8Array {
  return deriveKey(config, IP_KEY_INFO);
}

/** Keyed hash of a client IP (32 bytes) for `viewer_sessions` / `share_passcode_failures`. */
export function hashClientIp(config: SecretConfig, ip: string): Buffer {
  return createHmac("sha256", shareIpKey(config)).update(ip, "utf8").digest();
}

/** Keyed hash of the coarse user-agent label ("Safari on iPhone"), never the raw header. */
export function hashUserAgent(config: SecretConfig, userAgent: string | null): Buffer {
  return createHmac("sha256", shareIpKey(config))
    .update(userAgentLabel(userAgent), "utf8")
    .digest();
}

// ---- viewer JWT -----------------------------------------------------------------------------------

/** `iss` of viewer JWTs: `${PUBLIC_URL}/api/share` (GoTrue's is `${PUBLIC_URL}/auth`). */
export function viewerJwtIssuer(config: Pick<ApiConfig, "PUBLIC_URL">): string {
  return `${config.PUBLIC_URL.replace(/\/+$/, "")}${VIEWER_COOKIE_PATH}`;
}

/**
 * `exp` (seconds) of a viewer JWT: the link's expiry, never more than the 30-day maximum ahead
 * (PRD: `exp` = the link's expiry).
 */
export function viewerJwtExp(linkExpiresAt: Date, now: Date = new Date()): number {
  const cap = now.getTime() + SHARE_LINK_MAX_TTL_HOURS * 3600_000;
  return Math.floor(Math.min(linkExpiresAt.getTime(), cap) / 1000);
}

export interface MintViewerJwtInput {
  shareLinkId: string;
  /** `viewer_sessions.id`. */
  sessionId: string;
  linkExpiresAt: Date;
  now?: Date;
}

/**
 * Mint a viewer JWT: HS256 with `viewerJwtKey`, `iss` = `viewerJwtIssuer`, `aud` =
 * `littlelight-viewer`, payload exactly `{ role: "viewer", share_link_id, iat, exp, jti }`.
 */
export async function mintViewerJwt(
  config: IssuerConfig,
  input: MintViewerJwtInput,
): Promise<{ token: string; exp: number }> {
  const now = input.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = viewerJwtExp(input.linkExpiresAt, now);
  const token = await new SignJWT({ role: "viewer", share_link_id: input.shareLinkId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(viewerJwtIssuer(config))
    .setAudience(VIEWER_JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(input.sessionId)
    .sign(viewerJwtKey(config));
  return { token, exp };
}

export type ViewerJwtFailure = "expired" | "invalid";

/** Thrown by `verifyViewerJwt`; carries no part of the token. */
export class ViewerJwtError extends Error {
  readonly reason: ViewerJwtFailure;
  constructor(reason: ViewerJwtFailure) {
    super(reason === "expired" ? "viewer token expired" : "viewer token invalid");
    this.name = "ViewerJwtError";
    this.reason = reason;
  }
}

/**
 * Verify a viewer JWT (key, HS256 only, issuer, audience, expiry with 5 s tolerance) and parse
 * it with `viewerSessionClaimsSchema` (`jti` uuid and `iat` required; extra claims stripped). A
 * GoTrue access token fails here (wrong key, issuer and audience), as does anything else.
 */
export async function verifyViewerJwt(
  token: string,
  config: IssuerConfig,
  now?: Date,
): Promise<ViewerSessionClaims> {
  let payload: unknown;
  try {
    const result = await jwtVerify(token, viewerJwtKey(config), {
      algorithms: ["HS256"],
      issuer: viewerJwtIssuer(config),
      audience: VIEWER_JWT_AUDIENCE,
      clockTolerance: VIEWER_JWT_CLOCK_TOLERANCE_SEC,
      requiredClaims: ["exp", "iat", "jti"],
      ...(now ? { currentDate: now } : {}),
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new ViewerJwtError("expired");
    throw new ViewerJwtError("invalid");
  }
  const parsed = viewerSessionClaimsSchema.safeParse(payload);
  if (!parsed.success) throw new ViewerJwtError("invalid");
  return parsed.data;
}
