import {
  type GoogleImportEnv,
  googleImportEndpoints,
  googleTokenErrorSchema,
  googleTokenResponseSchema,
  type PickerMediaItemsPage,
  pickerMediaItemsPageSchema,
} from "@littlelight/shared";

// Server-to-server Google calls of the `import.google` worker (docs/plans/step-10.md 2.7, D6):
// refresh the requester's access token, list the picked media items, delete the Picker session.
// Plain `fetch` with timeouts and `redirect: "manual"`, base URLs from `googleImportEndpoints`
// (`fake` ⇒ the dev/CI fake), every response parsed with the shared schemas. 429 and 5xx (and
// connection errors) are retried a bounded number of times, honouring a short `Retry-After`.
// Failures become a `GoogleError` carrying a category and a status only: never a token, a
// session id, a URL or Google's own error text, so it is safe to log. The media download itself
// lives in `download.ts` (SSRF guard).

/** Timeout of each Google API call (token, list, delete). */
export const GOOGLE_CALL_TIMEOUT_MS = 15_000;
/** Attempts per Google API call for 429 / 5xx / connection errors (1 + 2 retries). */
export const GOOGLE_CALL_ATTEMPTS = 3;
/** Longest wait between attempts, whatever `Retry-After` says. */
export const GOOGLE_RETRY_MAX_DELAY_MS = 30_000;
/** Picker `pageSize` the worker asks for (Google's maximum). */
export const PICKER_PAGE_SIZE = 100;

/**
 * - `google_denied`: Google refused the request (400/401/403 and other 4xx).
 * - `google_reconnect`: `invalid_grant` on a refresh: the stored refresh token is dead.
 * - `not_found`: the Picker session is gone (deleted or expired at Google).
 * - `rate_limited`: 429 after every retry.
 * - `network`: timeout, connection error, 5xx after every retry.
 * - `internal`: a response that does not match the schema.
 */
export type GoogleErrorCategory =
  | "google_denied"
  | "google_reconnect"
  | "not_found"
  | "rate_limited"
  | "network"
  | "internal";

/** Category-only error (safe to log: no token, URL, session id or Google text). */
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

/** True for the categories worth another job attempt (pg-boss retry). */
export function isTransientGoogleError(err: unknown): boolean {
  return isGoogleError(err) && (err.category === "network" || err.category === "rate_limited");
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export interface WorkerGoogleClient {
  readonly provider: "fake" | "live";
  /** `refresh_token` grant ⇒ an access token, held in memory by the caller for this run only. */
  refreshAccessToken(refreshToken: string): Promise<string>;
  /** One page of the session's picked items (`pageSize` 100). */
  listMediaItems(
    accessToken: string,
    sessionId: string,
    pageToken?: string,
  ): Promise<PickerMediaItemsPage>;
  /** Best effort. `true` when deleted (or already gone). Never throws. */
  deleteSession(accessToken: string, sessionId: string): Promise<boolean>;
}

/** OAuth client id sent to the fake when none is configured (the fake does not check it). */
const FAKE_CLIENT_ID = "littlelight-dev";

function categoryForStatus(status: number): GoogleErrorCategory {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network";
  return "google_denied";
}

/** Retryable HTTP status: 429 and every 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Delay before attempt `attempt + 1` (attempt is 1-based): `Retry-After` seconds when present and
 * sane, else 1 s, 2 s, 4 s…; capped at `GOOGLE_RETRY_MAX_DELAY_MS`.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null | undefined): number {
  const header = typeof retryAfter === "string" ? retryAfter.trim() : "";
  if (/^\d{1,5}$/.test(header)) {
    return Math.min(Number(header) * 1000, GOOGLE_RETRY_MAX_DELAY_MS);
  }
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), GOOGLE_RETRY_MAX_DELAY_MS);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

export type GoogleClientSettings = Pick<
  GoogleImportEnv,
  | "GOOGLE_IMPORT_PROVIDER"
  | "GOOGLE_IMPORT_FAKE_URL"
  | "GOOGLE_IMPORT_FAKE_PUBLIC_URL"
  | "GOOGLE_IMPORT_CLIENT_ID"
  | "GOOGLE_IMPORT_CLIENT_SECRET"
>;

export interface GoogleClientOptions {
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  attempts?: number;
}

/**
 * The worker's Google client for the configured provider, or `null` when the provider is `none`
 * (the feature is unavailable; a stray batch then fails `internal`).
 */
export function createWorkerGoogleClient(
  settings: GoogleClientSettings,
  opts: GoogleClientOptions = {},
): WorkerGoogleClient | null {
  const endpoints = googleImportEndpoints(settings);
  if (!endpoints || settings.GOOGLE_IMPORT_PROVIDER === "none") return null;
  const provider = settings.GOOGLE_IMPORT_PROVIDER;
  const clientId =
    settings.GOOGLE_IMPORT_CLIENT_ID ?? (provider === "fake" ? FAKE_CLIENT_ID : undefined);
  if (!clientId) return null; // `live` without an id fails boot (schema); defensive only
  const clientSecret = settings.GOOGLE_IMPORT_CLIENT_SECRET;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = Math.max(1, opts.attempts ?? GOOGLE_CALL_ATTEMPTS);
  const tokenUrl = endpoints.tokenUrl;
  const picker = endpoints.pickerBaseUrl.replace(/\/+$/, "");

  /** One call; connection errors and timeouts become `GoogleError('network')` (no cause kept). */
  async function once(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleError("network");
    }
  }

  /**
   * `once` with bounded retries on 429 / 5xx / connection errors. Returns the last response
   * (which may still be a 429/5xx: the caller maps it).
   */
  async function withRetry(url: string, init: () => RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await once(url, init());
      } catch (err) {
        if (attempt >= attempts) throw err;
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      if (!isRetryableStatus(res.status) || attempt >= attempts) return res;
      const retryAfter = res.headers.get("retry-after");
      await drain(res);
      await sleep(retryDelayMs(attempt, retryAfter));
    }
  }

  function form(params: Record<string, string | undefined>): URLSearchParams {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
    return body;
  }

  function bearer(accessToken: string): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  }

  return {
    provider,
    async refreshAccessToken(refreshToken) {
      const res = await withRetry(tokenUrl, () => ({
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }));
      const json = await readJson(res);
      if (!res.ok) {
        const err = googleTokenErrorSchema.safeParse(json);
        if (err.success && err.data.error === "invalid_grant") {
          throw new GoogleError("google_reconnect", res.status);
        }
        throw new GoogleError(categoryForStatus(res.status), res.status);
      }
      const parsed = googleTokenResponseSchema.safeParse(json);
      if (!parsed.success) throw new GoogleError("internal", res.status);
      return parsed.data.access_token;
    },
    async listMediaItems(accessToken, sessionId, pageToken) {
      const url = new URL(`${picker}/v1/mediaItems`);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("pageSize", String(PICKER_PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await withRetry(url.href, () => ({
        method: "GET",
        headers: bearer(accessToken),
      }));
      if (!res.ok) {
        await drain(res);
        throw new GoogleError(categoryForStatus(res.status), res.status);
      }
      const parsed = pickerMediaItemsPageSchema.safeParse(await readJson(res));
      if (!parsed.success) throw new GoogleError("internal", res.status);
      return parsed.data;
    },
    async deleteSession(accessToken, sessionId) {
      try {
        const res = await once(`${picker}/v1/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers: bearer(accessToken),
        });
        await drain(res);
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },
  };
}
