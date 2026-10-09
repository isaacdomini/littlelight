import {
  type ApiErrorCode,
  apiErrorSchema,
  type ShareSessionResponse,
  shareSessionResponseSchema,
  type ViewerDownloadResponse,
  type ViewerPhotosResponse,
  type ViewerUrlsResponse,
  viewerDownloadResponseSchema,
  viewerPhotosResponseSchema,
  viewerUrlsResponseSchema,
} from "@littlelight/shared";
import type { ZodType } from "zod";
import { apiUrl } from "../platform/apiBase";
import { clientKind, isNative } from "../platform/platform";

// Viewer-side API client (`/api/share/*`, docs/plans/step-8.md 2.6). Deliberately separate from
// `lib/api.ts`: no parent session, no refresh, no sign-out events. The token only ever travels in
// the body of the one exchange request; it is never logged, stored or put in another URL.
//
// Native (docs/plans/step-9.md 2.7): no cookies cross origins, so the exchange returns a bearer
// `viewerToken` that lives in this module variable ONLY (never localStorage, Preferences or
// secure storage) and is sent as `Authorization: Bearer`. On 401/410 the exchange is re-run once
// (covers a renewed link), then the error surfaces as before (`share_link_expired`). The link
// token and passcode needed for that re-run are also kept in memory only.

let viewerToken: string | null = null;
let lastExchange: { token: string; passcode?: string } | null = null;

/** Forget the in-memory viewer session (leaving the viewer, app teardown). */
export function clearViewerSession(): void {
  viewerToken = null;
  lastExchange = null;
}

export class ShareApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network" | "unknown",
    message: string,
    readonly details?: unknown,
    /** Seconds from `Retry-After` (429s). */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ShareApiError";
  }
}

type Opts<T> = { method?: "GET" | "POST" | "DELETE"; body?: unknown; schema: ZodType<T> };

async function request<T>(path: string, opts: Opts<T>): Promise<T> {
  try {
    return await requestOnce(path, opts);
  } catch (e) {
    const gone = e instanceof ShareApiError && (e.status === 401 || e.status === 410);
    if (isNative() && gone && lastExchange && path !== "/session") {
      const again = lastExchange;
      await openShareSession(again.token, again.passcode);
      return requestOnce(path, opts);
    }
    throw e;
  }
}

async function requestOnce<T>(path: string, opts: Opts<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/share${path}`), {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      // The page URL carries the token; never send it as a Referer, not even same-origin.
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        "X-Littlelight-Client": clientKind(),
        ...(isNative() && viewerToken ? { Authorization: `Bearer ${viewerToken}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ShareApiError(0, "network", "Can't reach Littlelight. Check your connection.");
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const parsed = apiErrorSchema.safeParse(body);
    const retry = Number(res.headers.get("Retry-After"));
    throw parsed.success
      ? new ShareApiError(
          res.status,
          parsed.data.error,
          parsed.data.message,
          parsed.data.details,
          Number.isFinite(retry) && retry > 0 ? retry : undefined,
        )
      : new ShareApiError(res.status, "unknown", `Request failed (${res.status})`);
  }
  return opts.schema.parse(await res.json());
}

/** Exchange the link token (and passcode) for the viewer session cookie. */
export async function openShareSession(
  token: string,
  passcode?: string,
): Promise<ShareSessionResponse> {
  const res = await request("/session", {
    method: "POST",
    body: passcode ? { token, passcode } : { token },
    schema: shareSessionResponseSchema,
  });
  if (isNative()) {
    viewerToken = res.viewerToken ?? null;
    lastExchange = passcode ? { token, passcode } : { token };
  }
  return res;
}

export function fetchSharePhotos(cursor?: string): Promise<ViewerPhotosResponse> {
  const q = new URLSearchParams({ limit: "100" });
  if (cursor) q.set("cursor", cursor);
  return request(`/photos?${q.toString()}`, { schema: viewerPhotosResponseSchema });
}

export function fetchShareUrls(
  ids: string[],
  kind: "thumb" | "display",
): Promise<ViewerUrlsResponse> {
  return request("/photos/urls", {
    method: "POST",
    body: { ids, kind },
    schema: viewerUrlsResponseSchema,
  });
}

export function fetchShareDownload(id: string): Promise<ViewerDownloadResponse> {
  return request(`/photos/${id}/download`, {
    method: "POST",
    body: {},
    schema: viewerDownloadResponseSchema,
  });
}
