import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { googleConnectReturnPathSchema } from "@littlelight/shared";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { ApiConfig } from "../../config";

// The OAuth `state` of the Google connect flow (docs/plans/step-10.md 2.6, D14): a stateless
// HS256 JWT, so the callback needs no cookie (the native flow lands in SFSafariViewController /
// Custom Tabs, which have no app credentials). The key is HKDF-derived from `JWT_SECRET` with its
// own `info` (like the viewer JWT), so neither a GoTrue token nor a viewer token verifies here and
// a state JWT verifies nowhere else; its own issuer and audience as well. It binds the user
// (`sub`) and the GoTrue session (`sid`, re-checked live at the callback), expires after 10
// minutes and carries a random `jti`, which the callback consumes once
// (`createConsumedGoogleStates`). Never logged (pino drops query strings; `redactUrl`).

const HKDF_SALT = "littlelight";
const STATE_KEY_INFO = "google-oauth-state-v1";
export const GOOGLE_STATE_AUDIENCE = "littlelight-google-state";
/** Lifetime of a connect `state` (step-10 plan 2.6). */
export const GOOGLE_STATE_TTL_SEC = 600;
const CLOCK_TOLERANCE_SEC = 5;

type StateConfig = Pick<ApiConfig, "JWT_SECRET" | "PUBLIC_URL">;

const keyCache = new Map<string, Uint8Array>();

/** HS256 key of connect states: HKDF-SHA256(JWT_SECRET, "littlelight", "google-oauth-state-v1"). */
export function googleStateKey(config: Pick<ApiConfig, "JWT_SECRET">): Uint8Array {
  const cacheKey = createHash("sha256").update(config.JWT_SECRET).digest("base64url");
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = new Uint8Array(hkdfSync("sha256", config.JWT_SECRET, HKDF_SALT, STATE_KEY_INFO, 32));
  keyCache.set(cacheKey, key);
  return key;
}

/** `iss` of connect states: `${PUBLIC_URL}/api/import/google`. */
export function googleStateIssuer(config: Pick<ApiConfig, "PUBLIC_URL">): string {
  return `${config.PUBLIC_URL.replace(/\/+$/, "")}/api/import/google`;
}

export const googleStateClaimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  client: z.enum(["web", "native"]),
  returnTo: googleConnectReturnPathSchema,
  jti: z.uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type GoogleStateClaims = z.infer<typeof googleStateClaimsSchema>;

export interface MintGoogleStateInput {
  uid: string;
  sessionId: string;
  client: "web" | "native";
  returnTo: GoogleStateClaims["returnTo"];
  now?: Date;
}

export async function mintGoogleState(
  config: StateConfig,
  input: MintGoogleStateInput,
): Promise<string> {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return new SignJWT({ sid: input.sessionId, client: input.client, returnTo: input.returnTo })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(googleStateIssuer(config))
    .setAudience(GOOGLE_STATE_AUDIENCE)
    .setSubject(input.uid)
    .setIssuedAt(iat)
    .setExpirationTime(iat + GOOGLE_STATE_TTL_SEC)
    .setJti(randomUUID())
    .sign(googleStateKey(config));
}

/** Why a state failed (never carries any part of it). */
export type GoogleStateFailure = "expired" | "invalid";

/** Verify a connect state; `null` with the reason on any failure (never throws). */
export async function verifyGoogleState(
  config: StateConfig,
  state: string | undefined,
  now?: Date,
): Promise<{ ok: true; claims: GoogleStateClaims } | { ok: false; reason: GoogleStateFailure }> {
  if (typeof state !== "string" || state.length === 0 || state.length > 2048) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const { payload } = await jwtVerify(state, googleStateKey(config), {
      algorithms: ["HS256"],
      issuer: googleStateIssuer(config),
      audience: GOOGLE_STATE_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SEC,
      requiredClaims: ["sub", "exp", "iat", "jti"],
      ...(now ? { currentDate: now } : {}),
    });
    const parsed = googleStateClaimsSchema.safeParse(payload);
    return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, reason: "invalid" };
  } catch (err) {
    return { ok: false, reason: err instanceof joseErrors.JWTExpired ? "expired" : "invalid" };
  }
}

// ---------------------------------------------------------------------------------------------
// Single use (step 10 review should-fix 1)
// ---------------------------------------------------------------------------------------------

/** Most consumed states remembered at once; beyond it new callbacks fail closed (`expired`). */
export const MAX_CONSUMED_GOOGLE_STATES = 50_000;

export interface ConsumedGoogleStates {
  /**
   * Mark the state's `jti` used. `true` the first time; `false` when it was already used, when it
   * was minted before this store existed (an api restart forgets used `jti`s, so older states are
   * refused), or when the store is full. Call it before exchanging the code, so two parallel
   * callbacks with one state cannot both proceed.
   */
  consume(claims: Pick<GoogleStateClaims, "jti" | "iat" | "exp">): boolean;
  /** `jti`s remembered (expired ones until the next prune). */
  readonly size: number;
}

/**
 * In-memory register of used connect states (one api instance, `docker-compose.yml`). A `jti` is
 * kept until its state can no longer verify (`exp` + clock tolerance), then pruned. States minted
 * before the register was created are refused, which closes the replay window an api restart
 * would otherwise open: a parent mid-consent during a restart sees `expired` and starts again.
 */
export function createConsumedGoogleStates(
  opts: { now?: () => number; max?: number } = {},
): ConsumedGoogleStates {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? MAX_CONSUMED_GOOGLE_STATES;
  const createdAtSec = Math.floor(now() / 1000);
  /** jti => epoch ms after which the state cannot verify any more. */
  const used = new Map<string, number>();

  function prune(at: number): void {
    for (const [jti, until] of used) {
      if (at >= until) used.delete(jti);
    }
  }

  return {
    consume({ jti, iat, exp }) {
      if (iat < createdAtSec) return false;
      const at = now();
      prune(at);
      if (used.has(jti)) return false;
      if (used.size >= max) return false;
      used.set(jti, (exp + CLOCK_TOLERANCE_SEC) * 1000);
      return true;
    },
    get size() {
      return used.size;
    },
  };
}
