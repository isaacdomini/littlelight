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

// Viewer-side API client (`/api/share/*`, docs/plans/step-8.md 2.6). Deliberately separate from
// `lib/api.ts`: no parent session, no refresh, no sign-out events. The token only ever travels in
// the body of the one exchange request; it is never logged, stored or put in another URL.

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

async function request<T>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; body?: unknown; schema: ZodType<T> },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/share${path}`, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      // The page URL carries the token; never send it as a Referer, not even same-origin.
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        "X-Littlelight-Client": "web",
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
export function openShareSession(token: string, passcode?: string): Promise<ShareSessionResponse> {
  return request("/session", {
    method: "POST",
    body: passcode ? { token, passcode } : { token },
    schema: shareSessionResponseSchema,
  });
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
