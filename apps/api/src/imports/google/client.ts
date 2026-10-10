import {
  GOOGLE_PICKER_SCOPE,
  type GoogleImportEndpoints,
  type GoogleTokenResponse,
  googleImportEndpoints,
  googleTokenErrorSchema,
  googleTokenResponseSchema,
  type PickerSession,
  pickerSessionSchema,
} from "@tinyglow/shared";
import type { GoogleImportSettings } from "../../config";

// Server-to-server Google calls of the import API (docs/plans/step-10.md 2.6, D6, D14, D18):
// OAuth code exchange, refresh, revoke, and Picker sessions. Plain `fetch` with timeouts, base
// URLs from `googleImportEndpoints` (`fake` ⇒ the dev/CI fake), every response parsed with the
// shared schemas. Failures become a `GoogleError` carrying a category only: the error never holds
// a token, a code, a session id, a URL or Google's own error text, so it is safe to log.

/** Timeout of every Google call except revoke (step-10 plan 2.6). */
export const GOOGLE_CALL_TIMEOUT_MS = 15_000;
/** Revoke is best effort (disconnect, account deletion): never hold the request longer. */
export const GOOGLE_REVOKE_TIMEOUT_MS = 5_000;

/**
 * - `google_denied`: Google refused the request (bad code, 401/403 on the Picker, 4xx).
 * - `google_reconnect`: `invalid_grant` on a refresh: the stored refresh token is dead.
 * - `not_found`: the Picker session is gone (deleted or expired at Google).
 * - `rate_limited`: 429 from Google.
 * - `network`: timeout, connection error, 5xx.
 * - `internal`: a response that does not match the schema.
 */
export type GoogleErrorCategory =
  | "google_denied"
  | "google_reconnect"
  | "not_found"
  | "rate_limited"
  | "network"
  | "internal";

/** Category-only error (safe to log: no token, code, URL, session id or Google text). */
export class GoogleError extends Error {
  readonly category: GoogleErrorCategory;
  readonly status: number | undefined;
  constructor(category: GoogleErrorCategory, status?: number) {
    super(`google call failed: ${category}`);
    this.name = "GoogleError";
    this.category = category;
    this.status = status;
  }
}

export function isGoogleError(err: unknown): err is GoogleError {
  return err instanceof GoogleError;
}

export interface AuthUrlInput {
  state: string;
  redirectUri: string;
}

export interface GoogleClient {
  readonly provider: "fake" | "live";
  /** The consent URL the browser opens (D14: offline access, forced consent, Picker scope only). */
  authUrl(input: AuthUrlInput): string;
  /** `authorization_code` grant. */
  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokenResponse>;
  /** `refresh_token` grant ⇒ an access token (callers keep it in memory only). */
  refreshAccessToken(refreshToken: string): Promise<string>;
  /** `refresh_token` grant ⇒ the access token and its lifetime (for the per-user token cache). */
  refreshAccess(refreshToken: string): Promise<RefreshedAccess>;
  /** Revoke a token (best effort, 5 s). `true` when Google confirmed. Never throws. */
  revoke(token: string): Promise<boolean>;
  createSession(accessToken: string): Promise<PickerSession>;
  getSession(accessToken: string, sessionId: string): Promise<PickerSession>;
  /** Best effort. `true` when deleted (or already gone). Never throws. */
  deleteSession(accessToken: string, sessionId: string): Promise<boolean>;
  /**
   * `deleteSession` with the reason of a failure: `unauthorized` is a 401 (the access token is
   * dead: the caller drops it and may retry with a fresh one). Never throws.
   */
  closeSession(accessToken: string, sessionId: string): Promise<CloseSessionResult>;
}

/** A refreshed access token: in memory only, never logged, stored or returned to a client. */
export interface RefreshedAccess {
  accessToken: string;
  /** Google's `expires_in` (seconds from now). */
  expiresInSec: number;
}

export type CloseSessionResult = "deleted" | "unauthorized" | "failed";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** OAuth client id sent to the fake when none is configured (the fake does not check it). */
const FAKE_CLIENT_ID = "tinyglow-dev";

function categoryForStatus(status: number): GoogleErrorCategory {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network";
  return "google_denied";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The Google client for the configured provider, or `null` when the provider is `none` (the
 * feature is unavailable). `fetchImpl` is injectable for tests.
 */
export function createGoogleClient(
  settings: GoogleImportSettings,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): GoogleClient | null {
  const endpoints: GoogleImportEndpoints | null = googleImportEndpoints(settings);
  if (!endpoints || settings.GOOGLE_IMPORT_PROVIDER === "none") return null;
  const provider = settings.GOOGLE_IMPORT_PROVIDER;
  const clientId =
    settings.GOOGLE_IMPORT_CLIENT_ID ?? (provider === "fake" ? FAKE_CLIENT_ID : undefined);
  const clientSecret = settings.GOOGLE_IMPORT_CLIENT_SECRET;
  if (!clientId) return null; // `live` without an id fails boot (schema); defensive only
  const { authUrl, tokenUrl, revokeUrl } = endpoints;
  const picker = endpoints.pickerBaseUrl.replace(/\/+$/, "");

  async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Timeout or connection error. The cause may quote the URL: drop it.
      throw new GoogleError("network");
    }
  }

  function form(params: Record<string, string | undefined>): URLSearchParams {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
    return body;
  }

  async function tokenCall(params: Record<string, string | undefined>) {
    const res = await call(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form({ ...params, client_id: clientId, client_secret: clientSecret }),
      },
      GOOGLE_CALL_TIMEOUT_MS,
    );
    const json = await readJson(res);
    if (!res.ok) {
      const err = googleTokenErrorSchema.safeParse(json);
      if (err.success && err.data.error === "invalid_grant") {
        throw new GoogleError(
          params.grant_type === "refresh_token" ? "google_reconnect" : "google_denied",
          res.status,
        );
      }
      throw new GoogleError(categoryForStatus(res.status), res.status);
    }
    const parsed = googleTokenResponseSchema.safeParse(json);
    if (!parsed.success) throw new GoogleError("internal", res.status);
    return parsed.data;
  }

  async function pickerCall(
    method: "GET" | "POST" | "DELETE",
    path: string,
    accessToken: string,
  ): Promise<Response> {
    const res = await call(
      `${picker}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      },
      GOOGLE_CALL_TIMEOUT_MS,
    );
    return res;
  }

  async function parseSession(res: Response): Promise<PickerSession> {
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new GoogleError(categoryForStatus(res.status), res.status);
    }
    const parsed = pickerSessionSchema.safeParse(await readJson(res));
    if (!parsed.success) throw new GoogleError("internal", res.status);
    return parsed.data;
  }

  const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

  async function refreshAccess(refreshToken: string): Promise<RefreshedAccess> {
    const token = await tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });
    return { accessToken: token.access_token, expiresInSec: token.expires_in };
  }

  async function closeSession(accessToken: string, sessionId: string): Promise<CloseSessionResult> {
    try {
      const res = await pickerCall("DELETE", sessionPath(sessionId), accessToken);
      await res.body?.cancel().catch(() => undefined);
      if (res.ok || res.status === 404) return "deleted";
      return res.status === 401 ? "unauthorized" : "failed";
    } catch {
      return "failed";
    }
  }

  return {
    provider,
    authUrl({ state, redirectUri }) {
      const url = new URL(authUrl);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GOOGLE_PICKER_SCOPE);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("state", state);
      return url.href;
    },
    async exchangeCode(code, redirectUri) {
      return tokenCall({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
    },
    async refreshAccessToken(refreshToken) {
      return (await refreshAccess(refreshToken)).accessToken;
    },
    refreshAccess,
    async revoke(token) {
      try {
        const res = await call(
          revokeUrl,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form({ token }),
          },
          GOOGLE_REVOKE_TIMEOUT_MS,
        );
        await res.body?.cancel().catch(() => undefined);
        return res.ok;
      } catch {
        return false;
      }
    },
    async createSession(accessToken) {
      return parseSession(await pickerCall("POST", "/v1/sessions", accessToken));
    },
    async getSession(accessToken, sessionId) {
      return parseSession(await pickerCall("GET", sessionPath(sessionId), accessToken));
    },
    async deleteSession(accessToken, sessionId) {
      return (await closeSession(accessToken, sessionId)) === "deleted";
    },
    closeSession,
  };
}
