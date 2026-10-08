import type { OAuthProvider } from "@littlelight/shared";
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

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;

/** A GoTrue 4xx/5xx or transport failure. `code` is GoTrue's `error_code` or an errno, never text. */
export class GoTrueError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`gotrue request failed (${status} ${code})`);
    this.name = "GoTrueError";
    this.status = status;
    this.code = code;
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
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
    user: { id: user.id, email },
  };
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
): GoTrueClient {
  const base = config.AUTH_INTERNAL_URL.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? fetch;

  async function call(
    method: "GET" | "POST" | "DELETE",
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
    if (!res.ok) throw new GoTrueError(res.status, errorCodeOf(parsed, res.status));
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
  };
}
