import { type ApiErrorCode, apiErrorSchema } from "@littlelight/shared";
import type { ZodType } from "zod";
import { clientKind, isNative } from "../platform/platform";
import { getTokenStore } from "../platform/tokenStore";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | "network" | "unknown";
  readonly details: unknown;
  constructor(status: number, code: ApiError["code"], message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: ApiError["code"]): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

type Listener = () => void;
const signedOutListeners = new Set<Listener>();
/** AuthProvider subscribes: fires when the session is gone and cannot be refreshed. */
export function onSignedOut(cb: Listener): () => void {
  signedOutListeners.add(cb);
  return () => signedOutListeners.delete(cb);
}
function emitSignedOut() {
  for (const cb of signedOutListeners) cb();
}

export interface ApiResult<T> {
  status: number;
  data: T;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  schema?: ZodType<T>;
}

const API_PREFIX = "/api";
// Endpoints whose 401/4xx are ordinary form errors, not a lost session.
const NO_SESSION_EFFECT = ["/auth/otp", "/auth/verify", "/auth/pkce", "/auth/id-token"];

async function headers(hasBody: boolean): Promise<Headers> {
  const h = new Headers({ Accept: "application/json", "X-Littlelight-Client": clientKind() });
  if (hasBody) h.set("Content-Type", "application/json");
  if (isNative()) {
    const tokens = await getTokenStore().get();
    if (tokens) h.set("Authorization", `Bearer ${tokens.accessToken}`);
  }
  return h;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new ApiError(res.status, parsed.data.error, parsed.data.message, parsed.data.details);
  }
  return new ApiError(res.status, "unknown", `Request failed (${res.status})`);
}

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight `POST /api/auth/refresh`; true when a new session was issued. */
function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const native = isNative();
      const stored = native ? await getTokenStore().get() : null;
      const res = await fetch(`${API_PREFIX}/auth/refresh`, {
        method: "POST",
        credentials: "same-origin",
        headers: await headers(true),
        body: JSON.stringify(stored ? { refreshToken: stored.refreshToken } : {}),
      });
      if (!res.ok) return false;
      if (native) {
        const body = (await res.json()) as {
          tokens?: { accessToken: string; refreshToken: string };
        };
        if (!body.tokens) return false;
        await getTokenStore().set(body.tokens);
      }
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

async function once(path: string, opts: RequestOptions<unknown>): Promise<Response> {
  const hasBody = opts.body !== undefined;
  try {
    return await fetch(`${API_PREFIX}${path}`, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: await headers(hasBody),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach Littlelight. Check your connection.");
  }
}

/** Typed JSON request with the client header, one transparent refresh, and ApiError mapping. */
export async function apiRequest<T = void>(
  path: string,
  opts: RequestOptions<T> = {},
): Promise<ApiResult<T>> {
  let res = await once(path, opts);
  if (res.status === 401 && !path.startsWith("/auth/refresh")) {
    const err = await parseError(res.clone());
    if (err.code === "token_expired") {
      if (await refreshSession()) {
        res = await once(path, opts);
      } else {
        emitSignedOut();
        throw new ApiError(401, "unauthorized", err.message);
      }
    }
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && !NO_SESSION_EFFECT.some((p) => path.startsWith(p))) {
      emitSignedOut();
    }
    throw err;
  }
  const text = res.status === 204 ? "" : await res.text();
  if (!text) return { status: res.status, data: undefined as T };
  const json: unknown = JSON.parse(text);
  const data = opts.schema ? opts.schema.parse(json) : (json as T);
  return { status: res.status, data };
}

export async function apiFetch<T = void>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  return (await apiRequest(path, opts)).data;
}

/** Message safe to show: server messages are user-safe by contract; anything else is generic. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Please try again.";
}
