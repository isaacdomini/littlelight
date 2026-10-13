import {
  type GoTruePasskey,
  type GoTruePasskeyOptions,
  goTruePasskeyListSchema,
  goTruePasskeyOptionsSchema,
  goTruePasskeySchema,
  type OAuthProvider,
  type PublicKeyCredentialJson,
} from "@tinyglow/shared";
import type { ApiConfig } from "../config";
import { mintAdminJwt } from "./admin-jwt";

// Thin HTTP client for self-hosted GoTrue (docs/plans/step-3.md 2.1, 2.3, D1). The API is
// GoTrue's only client for codes, verification, refresh and sign-out; browsers reach GoTrue only
// for the OAuth redirect endpoints. Every call forwards the real client's IP and User-Agent
// (`upstreamClientHeaders` in lib/request.ts) so `auth.sessions.ip/user_agent` and GoTrue's own
// per-IP limits (`GOTRUE_RATE_LIMIT_HEADER`) see the browser, not the API container: GoTrue
// applies no per-IP limit at all unless that header is present.
//
// Logging rule: a `GoTrueError` carries the HTTP status and GoTrue's short `error_code`
// (identifier-shaped) only; the message body, which can quote the email or token, is dropped.

/** Headers describing the end client, forwarded verbatim (built by `upstreamClientHeaders`). */
export type UpstreamHeaders = Readonly<Record<string, string>>;

/** The parts of GoTrue's `AccessTokenResponse` the API uses. */
export interface GoTrueSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: GoTrueUser;
}

export interface GoTrueUser {
  id: string;
  email: string | null;
  /**
   * Identity provider of the sign-in that produced this session (`apple`, `google`, `email`, …),
   * read from the session body: the identity with the latest `last_sign_in_at`, else
   * `app_metadata.provider`. Present only when GoTrue told us; used to record the OAuth
   * `method` on `auth.sign_in` for the PKCE exchange, whose request body names no provider.
   */
  provider?: string;
}

export type VerifyInput =
  | { kind: "code"; email: string; token: string }
  | { kind: "token_hash"; tokenHash: string };

export interface PkceInput {
  authCode: string;
  codeVerifier: string;
}

export interface IdTokenInput {
  provider: OAuthProvider;
  idToken: string;
  nonce?: string;
  accessToken?: string;
}

export type LogoutScope = "local" | "global" | "others";

export interface GoTrueClient {
  /** `POST /otp` with `create_user: true`. Throws `GoTrueError`; the route stays generic regardless. */
  sendOtp(email: string, upstream: UpstreamHeaders): Promise<void>;
  /** `POST /verify {type:"email", …}`: the 6-digit code or the magic-link `token_hash`. */
  verify(input: VerifyInput, upstream: UpstreamHeaders): Promise<GoTrueSession>;
  /** `POST /token?grant_type=pkce` (OAuth web return). */
  exchangePkce(input: PkceInput, upstream: UpstreamHeaders): Promise<GoTrueSession>;
  /** `POST /token?grant_type=id_token` (native Apple/Google, step 9). */
  signInWithIdToken(input: IdTokenInput, upstream: UpstreamHeaders): Promise<GoTrueSession>;
  /** `POST /token?grant_type=refresh_token`. Rotates; reuse past the 10 s window revokes the family. */
  refresh(refreshToken: string, upstream: UpstreamHeaders): Promise<GoTrueSession>;
  /** `POST /logout?scope=…` with the user's access token. */
  logout(accessToken: string, scope: LogoutScope, upstream: UpstreamHeaders): Promise<void>;
  /** `DELETE /admin/users/{id}` with a freshly minted 60 s `service_role` JWT (hard delete). */
  adminDeleteUser(userId: string): Promise<void>;
}

/**
 * Store-review sign-in only (docs/plans/step-9.md 2.5, D4). A separate interface (not a member of
 * `GoTrueClient`) so recording stubs written before step 9 (`testing/support.ts`) still
 * type-check; `createGoTrueClient` always implements it and the review sign-in fails closed (503)
 * when the client in use does not (`hasReviewLinks`).
 */
export interface GoTrueReviewLinks {
  /**
   * `POST /admin/generate_link {type:"magiclink", email}` with a freshly minted 60 s
   * `service_role` JWT. GoTrue sends no email for admin-generated links; it creates the user if
   * the email is unknown (like `sendOtp`'s `create_user`). Returns the user id and the single-use
   * `hashed_token` that `verify({kind:"token_hash"})` redeems; the response's `email_otp` and
   * `action_link` are dropped here and never leave this function. Never log the result.
   */
  adminGenerateMagicLink(email: string): Promise<GeneratedMagicLink>;
}

export function hasReviewLinks<T extends object>(client: T): client is T & GoTrueReviewLinks {
  return typeof (client as Partial<GoTrueReviewLinks>).adminGenerateMagicLink === "function";
}

/** What `adminGenerateMagicLink` keeps from GoTrue's response. `hashedToken` is a credential. */
export interface GeneratedMagicLink {
  userId: string;
  hashedToken: string;
}

/** `{ challengeId, credential }` as the API received it; forwarded to GoTrue as `{ challenge_id, credential }`. */
export interface PasskeyCeremonyInput {
  challengeId: string;
  credential: PublicKeyCredentialJson;
}

/**
 * GoTrue's beta passkey routes (docs/plans/step-13.md 0.1, 2.4; verified against
 * `supabase/auth:v2.197.0`). A separate interface, like `GoTrueReviewLinks`, so recording stubs
 * written before step 13 still type-check; `createGoTrueClient` always implements it and the
 * passkey routes fail closed (503) when the client in use does not (`hasPasskeys`). Wire shapes
 * are parsed with the shared `goTruePasskey*` schemas: `expires_at` is Unix seconds (the routes
 * convert, decision a), `GET /passkeys/` is a bare array, registration verify answers 200.
 * Nothing here is logged; a `GoTrueError` carries status + `error_code` only.
 */
export interface GoTruePasskeys {
  /** `POST /passkeys/authentication/options` (public). Forwards the client headers so GoTrue's own limiter keys on the browser IP (decision d). */
  passkeyAuthOptions(upstream: UpstreamHeaders): Promise<GoTruePasskeyOptions>;
  /** `POST /passkeys/authentication/verify` → a full session (AMR `passkey`). No GoTrue rate limit: the routes throttle. */
  passkeyAuthVerify(input: PasskeyCeremonyInput, upstream: UpstreamHeaders): Promise<GoTrueSession>;
  /** `POST /passkeys/registration/options` with the user's access token (body ignored by GoTrue). */
  passkeyRegOptions(accessToken: string, upstream: UpstreamHeaders): Promise<GoTruePasskeyOptions>;
  /** `POST /passkeys/registration/verify` (200 upstream) → the new passkey. */
  passkeyRegVerify(
    accessToken: string,
    input: PasskeyCeremonyInput,
    upstream: UpstreamHeaders,
  ): Promise<GoTruePasskey>;
  /** `GET /passkeys/` → the user's passkeys (bare array upstream). */
  passkeyList(accessToken: string): Promise<GoTruePasskey[]>;
  /** `PATCH /passkeys/{id} { friendly_name }` → the updated passkey. Unknown id: 404 `validation_failed`. */
  passkeyRename(accessToken: string, id: string, name: string): Promise<GoTruePasskey>;
  /** `DELETE /passkeys/{id}` → 204. Unknown id: 404 `validation_failed`. */
  passkeyDelete(accessToken: string, id: string): Promise<void>;
}

export function hasPasskeys<T extends object>(client: T): client is T & GoTruePasskeys {
  const c = client as Partial<GoTruePasskeys>;
  return (
    typeof c.passkeyAuthOptions === "function" &&
    typeof c.passkeyAuthVerify === "function" &&
    typeof c.passkeyRegOptions === "function" &&
    typeof c.passkeyRegVerify === "function" &&
    typeof c.passkeyList === "function" &&
    typeof c.passkeyRename === "function" &&
    typeof c.passkeyDelete === "function"
  );
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;

/** A GoTrue 4xx/5xx or transport failure. `code` is GoTrue's `error_code` or an errno, never text. */
export class GoTrueError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds from GoTrue's `Retry-After` on a 429 (`over_request_rate_limit`); undefined otherwise. */
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, retryAfterSec?: number) {
    super(`gotrue request failed (${status} ${code})`);
    this.name = "GoTrueError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
}

/** Pull GoTrue's error identifier out of either of its two error body shapes. */
function errorCodeOf(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    // New shape: { code, error_code, msg }. Old /token shape: { error, error_description }.
    const candidate = b.error_code ?? b.error;
    const code = safeCode(candidate, "");
    if (code) return code;
  }
  return `http_${status}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Longest `Retry-After` the API will relay (an hour: GoTrue's limiter windows are 5 min / 1 h). */
const RETRY_AFTER_MAX_SEC = 3600;

/**
 * `Retry-After` of a GoTrue response as whole seconds, 1..`RETRY_AFTER_MAX_SEC`: a delta-seconds
 * value or an HTTP-date; anything else (absent, garbage, in the past) ⇒ undefined. Exported for tests.
 */
export function retryAfterSecOf(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  let sec: number;
  if (/^\d{1,7}$/.test(raw)) {
    sec = Number(raw);
  } else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    sec = Math.ceil((at - nowMs) / 1000);
  }
  if (!Number.isFinite(sec) || sec < 1) return undefined;
  return Math.min(RETRY_AFTER_MAX_SEC, Math.ceil(sec));
}

function toSession(body: unknown): GoTrueSession {
  if (!isRecord(body)) throw new GoTrueError(502, "bad_session_body");
  const { access_token, refresh_token, expires_in, user } = body;
  if (
    typeof access_token !== "string" ||
    typeof refresh_token !== "string" ||
    typeof expires_in !== "number" ||
    !isRecord(user) ||
    typeof user.id !== "string"
  ) {
    throw new GoTrueError(502, "bad_session_body");
  }
  const email = typeof user.email === "string" && user.email !== "" ? user.email : null;
  const provider = providerOf(user);
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
    user: { id: user.id, email, ...(provider ? { provider } : {}) },
  };
}

/** Provider of the identity used for this sign-in (latest `last_sign_in_at`), else `app_metadata.provider`. */
function providerOf(user: Record<string, unknown>): string | undefined {
  let best: { provider: string; at: number } | undefined;
  if (Array.isArray(user.identities)) {
    for (const ident of user.identities) {
      if (!isRecord(ident)) continue;
      const provider = safeCode(ident.provider, "");
      if (!provider) continue;
      const at =
        typeof ident.last_sign_in_at === "string" ? Date.parse(ident.last_sign_in_at) : NaN;
      const score = Number.isNaN(at) ? -1 : at;
      if (!best || score > best.at) best = { provider, at: score };
    }
  }
  if (best) return best.provider;
  if (isRecord(user.app_metadata)) {
    const p = safeCode(user.app_metadata.provider, "");
    if (p) return p;
  }
  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep only the user id and `hashed_token` of a `/admin/generate_link` body (verified on v2.197.0: top-level `id`, `hashed_token`). */
function toGeneratedLink(body: unknown): GeneratedMagicLink {
  if (!isRecord(body)) throw new GoTrueError(502, "bad_generate_link_body");
  const { id, hashed_token } = body;
  if (
    typeof id !== "string" ||
    !UUID_RE.test(id) ||
    typeof hashed_token !== "string" ||
    hashed_token.length === 0 ||
    hashed_token.length > 512
  ) {
    throw new GoTrueError(502, "bad_generate_link_body");
  }
  return { userId: id.toLowerCase(), hashedToken: hashed_token };
}

// Passkey wire shapes (v2.197.0, docs/plans/step-13.md 0.1). A body that does not parse is a 502
// `bad_passkey_body`: the routes map it like any other upstream failure, never echoing it.

function toPasskeyOptions(body: unknown): GoTruePasskeyOptions {
  const parsed = goTruePasskeyOptionsSchema.safeParse(body);
  if (!parsed.success) throw new GoTrueError(502, "bad_passkey_body");
  return parsed.data;
}

function toPasskey(body: unknown): GoTruePasskey {
  const parsed = goTruePasskeySchema.safeParse(body);
  if (!parsed.success) throw new GoTrueError(502, "bad_passkey_body");
  return parsed.data;
}

function toPasskeyList(body: unknown): GoTruePasskey[] {
  // GoTrue answers `null` for a user without passkeys in some versions; treat it as empty.
  const parsed = goTruePasskeyListSchema.safeParse(body ?? []);
  if (!parsed.success) throw new GoTrueError(502, "bad_passkey_body");
  return parsed.data;
}

function ceremonyBody(input: PasskeyCeremonyInput): Record<string, unknown> {
  return { challenge_id: input.challengeId, credential: input.credential };
}

export interface GoTrueClientOptions {
  /** Per-request timeout; GoTrue is on the internal network and should answer in milliseconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type GoTrueConfig = Pick<ApiConfig, "AUTH_INTERNAL_URL" | "JWT_SECRET" | "PUBLIC_URL">;

/** fetch-based implementation against `AUTH_INTERNAL_URL`. */
export function createGoTrueClient(
  config: GoTrueConfig,
  options: GoTrueClientOptions = {},
): GoTrueClient & GoTrueReviewLinks & GoTruePasskeys {
  const base = config.AUTH_INTERNAL_URL.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? fetch;

  async function call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...headers,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      const code = (err as { code?: unknown; name?: unknown } | null) ?? {};
      throw new GoTrueError(
        503,
        safeCode(code.code, code.name === "AbortError" ? "timeout" : "network"),
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      throw new GoTrueError(
        res.status,
        errorCodeOf(parsed, res.status),
        res.status === 429 ? retryAfterSecOf(res.headers.get("retry-after")) : undefined,
      );
    }
    return parsed;
  }

  return {
    async sendOtp(email, upstream) {
      await call("POST", "/otp", { email, create_user: true }, { ...upstream });
    },

    async verify(input, upstream) {
      const body =
        input.kind === "code"
          ? { type: "email", email: input.email, token: input.token }
          : { type: "email", token_hash: input.tokenHash };
      return toSession(await call("POST", "/verify", body, { ...upstream }));
    },

    async exchangePkce(input, upstream) {
      return toSession(
        await call(
          "POST",
          "/token?grant_type=pkce",
          { auth_code: input.authCode, code_verifier: input.codeVerifier },
          { ...upstream },
        ),
      );
    },

    async signInWithIdToken(input, upstream) {
      return toSession(
        await call(
          "POST",
          "/token?grant_type=id_token",
          {
            provider: input.provider,
            id_token: input.idToken,
            ...(input.nonce ? { nonce: input.nonce } : {}),
            ...(input.accessToken ? { access_token: input.accessToken } : {}),
          },
          { ...upstream },
        ),
      );
    },

    async refresh(refreshToken, upstream) {
      return toSession(
        await call(
          "POST",
          "/token?grant_type=refresh_token",
          { refresh_token: refreshToken },
          { ...upstream },
        ),
      );
    },

    async logout(accessToken, scope, upstream) {
      await call("POST", `/logout?scope=${scope}`, undefined, {
        ...upstream,
        authorization: `Bearer ${accessToken}`,
      });
    },

    async adminDeleteUser(userId) {
      // Minted per call, 60 s lifetime, never stored (docs/plans/step-3.md 2.3, 3.4).
      const jwt = await mintAdminJwt(config);
      await call("DELETE", `/admin/users/${encodeURIComponent(userId)}`, undefined, {
        authorization: `Bearer ${jwt}`,
      });
    },

    async adminGenerateMagicLink(email) {
      const jwt = await mintAdminJwt(config);
      return toGeneratedLink(
        await call(
          "POST",
          "/admin/generate_link",
          { type: "magiclink", email },
          { authorization: `Bearer ${jwt}` },
        ),
      );
    },

    // Passkeys (docs/plans/step-13.md 2.4). The user's own access token authenticates the
    // registration and management routes; the authentication routes are public.
    async passkeyAuthOptions(upstream) {
      return toPasskeyOptions(
        await call("POST", "/passkeys/authentication/options", {}, { ...upstream }),
      );
    },

    async passkeyAuthVerify(input, upstream) {
      return toSession(
        await call("POST", "/passkeys/authentication/verify", ceremonyBody(input), {
          ...upstream,
        }),
      );
    },

    async passkeyRegOptions(accessToken, upstream) {
      return toPasskeyOptions(
        await call(
          "POST",
          "/passkeys/registration/options",
          {},
          { ...upstream, authorization: `Bearer ${accessToken}` },
        ),
      );
    },

    async passkeyRegVerify(accessToken, input, upstream) {
      return toPasskey(
        await call("POST", "/passkeys/registration/verify", ceremonyBody(input), {
          ...upstream,
          authorization: `Bearer ${accessToken}`,
        }),
      );
    },

    async passkeyList(accessToken) {
      return toPasskeyList(
        await call("GET", "/passkeys/", undefined, { authorization: `Bearer ${accessToken}` }),
      );
    },

    async passkeyRename(accessToken, id, name) {
      return toPasskey(
        await call(
          "PATCH",
          `/passkeys/${encodeURIComponent(id)}`,
          { friendly_name: name },
          { authorization: `Bearer ${accessToken}` },
        ),
      );
    },

    async passkeyDelete(accessToken, id) {
      await call("DELETE", `/passkeys/${encodeURIComponent(id)}`, undefined, {
        authorization: `Bearer ${accessToken}`,
      });
    },
  };
}
