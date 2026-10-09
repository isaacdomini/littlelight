import {
  originalUrlResponseSchema,
  PHOTO_BATCH_MAX,
  type Photo,
  type PhotoDetailsPatch,
  type PhotoSummary,
  type PhotosBatchDetailsRequest,
  type PhotosListDir,
  type PhotosListResponse,
  type PhotosView,
  type PhotoUrlSet,
  photoSchema,
  photoSummarySchema,
  photosBatchDetailsResponseSchema,
  photosListResponseSchema,
  photosSummaryResponseSchema,
  photoUrlsResponseSchema,
} from "@littlelight/shared";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch } from "../api";
import { uploadManager } from "../upload/manager";

export const photosRoot = (babyId: string) => ["babies", babyId, "photos"] as const;
export const photosKey = (babyId: string, view: PhotosView) =>
  [...photosRoot(babyId), view] as const;
export const photoKey = (photoId: string) => ["photo", photoId] as const;

/** Signed thumbnail URLs live 1 h (`urlExpiresAt`); refetch well before they expire. */
const PHOTOS_STALE_MS = 45 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

// ---- step 4 flat list (kept for the approval queue) -----------------------------------------

export function useBabyPhotos(babyId: string | undefined, view: PhotosView = "album") {
  return useInfiniteQuery({
    queryKey: photosKey(babyId ?? "none", view),
    enabled: !!babyId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ view, limit: "100" });
      if (pageParam) qs.set("cursor", pageParam);
      return apiFetch(`/babies/${babyId}/photos?${qs.toString()}`, {
        schema: photosListResponseSchema,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: PHOTOS_STALE_MS,
    refetchInterval: PHOTOS_STALE_MS,
  });
}

// ---- step 5 timeline -----------------------------------------------------------------------

export interface TimelineOptions {
  view?: PhotosView;
  /** Only photos tagged with this milestone. */
  milestoneId?: string;
  /** Group cursor from the summary: starts the stream there (scrubber jump). */
  startCursor?: string;
}

export interface TimelinePageParam {
  cursor?: string;
  dir: PhotosListDir;
}

export const timelineKey = (babyId: string, o: TimelineOptions = {}) =>
  [
    ...photosRoot(babyId),
    "timeline",
    o.view ?? "album",
    o.milestoneId ?? null,
    o.startCursor ?? null,
  ] as const;

/**
 * Keyset-paged timeline, newest first, 200 per page. `fetchNextPage` loads older photos;
 * `fetchPreviousPage` loads newer ones (only meaningful after a `startCursor` jump). Kept in
 * memory for 24 h so scrolling back and the offline banner still show the grid (D9).
 */
export function useTimeline(babyId: string | undefined, options: TimelineOptions = {}) {
  const { view = "album", milestoneId, startCursor } = options;
  return useInfiniteQuery<
    PhotosListResponse,
    Error,
    InfiniteData<PhotosListResponse, TimelinePageParam>,
    ReturnType<typeof timelineKey>,
    TimelinePageParam
  >({
    queryKey: timelineKey(babyId ?? "none", options),
    enabled: !!babyId,
    initialPageParam: { cursor: startCursor, dir: "older" },
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ view, limit: "200", dir: pageParam.dir });
      if (pageParam.cursor) qs.set("cursor", pageParam.cursor);
      if (milestoneId) qs.set("milestoneId", milestoneId);
      return apiFetch(`/babies/${babyId}/photos?${qs.toString()}`, {
        schema: photosListResponseSchema,
      });
    },
    getNextPageParam: (last) =>
      last.nextCursor ? { cursor: last.nextCursor, dir: "older" as const } : undefined,
    getPreviousPageParam: (first) =>
      startCursor && first.prevCursor
        ? { cursor: first.prevCursor, dir: "newer" as const }
        : undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: DAY_MS,
    refetchOnWindowFocus: false,
  });
}

/** Age groups with counts and jump cursors, plus the total, for the scrubber and headers. */
export function useTimelineSummary(babyId: string | undefined, view: PhotosView = "album") {
  return useQuery({
    queryKey: [...photosRoot(babyId ?? "none"), "summary", view] as const,
    enabled: !!babyId,
    staleTime: 5 * 60_000,
    gcTime: DAY_MS,
    queryFn: () =>
      apiFetch(`/babies/${babyId}/photos/summary?view=${view}`, {
        schema: photosSummaryResponseSchema,
      }),
  });
}

/** AI states in which the analysis result is expected soon: the detail refetches every 30 s. */
const AI_POLL_MS = 30_000;
const isAiInFlight = (status: string | undefined) => status === "queued" || status === "analyzing";

/**
 * Full photo (display URL, EXIF, details, measurements, `canEdit`, `ai`). Polls every 30 s only
 * while `ai.status` is queued/analyzing, and mirrors a changed `aiStatus` into the cached lists.
 */
export function usePhoto(photoId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: photoKey(photoId ?? "none"),
    enabled: !!photoId,
    staleTime: PHOTOS_STALE_MS,
    gcTime: DAY_MS,
    refetchInterval: (query) => (isAiInFlight(query.state.data?.ai.status) ? AI_POLL_MS : false),
    queryFn: async () => {
      const photo = await apiFetch(`/photos/${photoId}`, { schema: photoSchema });
      queryClient.setQueriesData(
        {
          predicate: (q) => q.queryKey[0] === "babies" && q.queryKey[2] === "photos",
        },
        (old: unknown) =>
          patchPages(old, (p) =>
            p.id === photo.id && (p.aiStatus !== photo.aiStatus || p.caption !== photo.caption)
              ? { ...p, aiStatus: photo.aiStatus, caption: photo.caption }
              : undefined,
          ),
      );
      return photo;
    },
  });
}

/** Flattens loaded timeline pages into one newest-first array. */
export function flattenTimeline(
  data: InfiniteData<PhotosListResponse, TimelinePageParam> | undefined,
): PhotoSummary[] {
  return data ? data.pages.flatMap((p) => p.photos) : [];
}

// ---- in-place cache patching (no refetch of every loaded page) -----------------------------

function patchPages(data: unknown, patch: (p: PhotoSummary) => PhotoSummary | undefined): unknown {
  const pages = (data as { pages?: PhotosListResponse[] } | undefined)?.pages;
  if (!Array.isArray(pages)) return data;
  let changed = false;
  const next = pages.map((page) => {
    if (!Array.isArray(page.photos)) return page;
    let pageChanged = false;
    const photos = page.photos.map((p) => {
      const r = patch(p);
      if (r && r !== p) {
        pageChanged = true;
        return r;
      }
      return p;
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, photos };
  });
  return changed ? { ...(data as object), pages: next } : data;
}

/** Applies `patch` to matching photos in every cached photo list of the baby. */
export function patchCachedPhotos(
  queryClient: QueryClient,
  babyId: string,
  patch: (p: PhotoSummary) => PhotoSummary | undefined,
): void {
  queryClient.setQueriesData({ queryKey: photosRoot(babyId) }, (old: unknown) =>
    patchPages(old, patch),
  );
}

// ---- URL refresh (batched) -----------------------------------------------------------------

const BATCH_DELAY_MS = 250;
interface Pending {
  resolvers: Map<string, Array<(u: PhotoUrlSet | null) => void>>;
  timer: ReturnType<typeof setTimeout> | null;
}
const pendingByBaby = new Map<string, Pending>();

async function flushRefresh(queryClient: QueryClient, babyId: string, pending: Pending) {
  pendingByBaby.delete(babyId);
  const ids = [...pending.resolvers.keys()];
  for (let i = 0; i < ids.length; i += PHOTO_BATCH_MAX) {
    const chunk = ids.slice(i, i + PHOTO_BATCH_MAX);
    let urls: Record<string, PhotoUrlSet> = {};
    try {
      const res = await apiFetch(`/babies/${babyId}/photos/urls`, {
        method: "POST",
        body: { photoIds: chunk },
        schema: photoUrlsResponseSchema,
      });
      urls = res.urls;
    } catch {
      // resolve with null below; the image shows its placeholder
    }
    patchCachedPhotos(queryClient, babyId, (p) => {
      const u = urls[p.id];
      return u ? { ...p, thumbUrl: u.thumbUrl, urlExpiresAt: u.urlExpiresAt } : undefined;
    });
    for (const id of chunk) {
      const u = urls[id];
      if (u) {
        queryClient.setQueryData<Photo>(photoKey(id), (old) =>
          old
            ? {
                ...old,
                thumbUrl: u.thumbUrl,
                displayUrl: u.displayUrl,
                urlExpiresAt: u.urlExpiresAt,
              }
            : old,
        );
      }
      for (const resolve of pending.resolvers.get(id) ?? []) resolve(u ?? null);
    }
  }
}

/** Queues `photoId` for a batched `POST /babies/:id/photos/urls` (250 ms window, ≤ 500 ids). */
export function requestFreshUrls(
  queryClient: QueryClient,
  babyId: string,
  photoId: string,
): Promise<PhotoUrlSet | null> {
  let pending = pendingByBaby.get(babyId);
  if (!pending) {
    pending = { resolvers: new Map(), timer: null };
    pendingByBaby.set(babyId, pending);
    const p = pending;
    p.timer = setTimeout(() => void flushRefresh(queryClient, babyId, p), BATCH_DELAY_MS);
  }
  return new Promise((resolve) => {
    const list = pending.resolvers.get(photoId) ?? [];
    list.push(resolve);
    pending.resolvers.set(photoId, list);
  });
}

/**
 * Returns `refresh(photoId)`: resolves with fresh signed URLs (or null when the photo is gone /
 * the request failed) and patches `thumbUrl`/`urlExpiresAt` into every cached list and the
 * photo detail. Calls within 250 ms share one request.
 */
export function useRefreshUrls(babyId: string | undefined) {
  const queryClient = useQueryClient();
  return (photoId: string): Promise<PhotoUrlSet | null> =>
    babyId ? requestFreshUrls(queryClient, babyId, photoId) : Promise.resolve(null);
}

// ---- details editing -----------------------------------------------------------------------

/** `PATCH /photos/:id/details`. Updates the detail cache and list badges in place. */
export function useUpdatePhotoDetails(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: PhotoDetailsPatch & { id: string }): Promise<Photo> =>
      apiFetch(`/photos/${id}/details`, { method: "PATCH", body: patch, schema: photoSchema }),
    onSuccess: (photo) => {
      queryClient.setQueryData(photoKey(photo.id), photo);
      patchCachedPhotos(queryClient, babyId, (p) =>
        p.id === photo.id
          ? { ...p, milestoneId: photo.milestoneId, caption: photo.caption }
          : undefined,
      );
      void queryClient.invalidateQueries({ queryKey: ["babies", babyId, "milestones"] });
    },
  });
}

/** `POST /babies/:id/photos/details` for a multi-selection. */
export function useBatchDetails(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PhotosBatchDetailsRequest) =>
      apiFetch(`/babies/${babyId}/photos/details`, {
        method: "POST",
        body: input,
        schema: photosBatchDetailsResponseSchema,
      }),
    onSuccess: (res, input) => {
      if (input.milestoneId !== undefined) {
        const updated = new Set(res.updated);
        const milestoneId = input.milestoneId;
        patchCachedPhotos(queryClient, babyId, (p) =>
          updated.has(p.id) ? { ...p, milestoneId } : undefined,
        );
      }
      for (const id of res.updated) void queryClient.invalidateQueries({ queryKey: photoKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["babies", babyId, "milestones"] });
    },
  });
}

// ---- upload hook + approval / trash (step 4) ----------------------------------------------

/** Refresh every photo list of the baby when uploads are ingested (any page that is mounted). */
export function usePhotosInvalidation() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      uploadManager.onPhotosChanged((babyId) => {
        void queryClient.invalidateQueries({ queryKey: photosRoot(babyId) });
        void queryClient.invalidateQueries({ queryKey: ["babies", babyId, "milestones"] });
      }),
    [queryClient],
  );
}

function useInvalidatePhotos(babyId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: photosRoot(babyId) });
    void queryClient.invalidateQueries({ queryKey: ["babies", babyId, "milestones"] });
  };
}

export function useApprovePhoto(babyId: string) {
  const invalidate = useInvalidatePhotos(babyId);
  return useMutation({
    mutationFn: (photoId: string) =>
      apiFetch(`/photos/${photoId}/approve`, { method: "POST", schema: photoSummarySchema }),
    onSettled: invalidate,
  });
}

export function useRejectPhoto(babyId: string) {
  const invalidate = useInvalidatePhotos(babyId);
  return useMutation({
    mutationFn: (photoId: string) =>
      apiFetch(`/photos/${photoId}/reject`, { method: "POST", schema: photoSummarySchema }),
    onSettled: invalidate,
  });
}

export function useDeletePhoto(babyId: string) {
  const invalidate = useInvalidatePhotos(babyId);
  return useMutation({
    mutationFn: (photoId: string) => apiFetch(`/photos/${photoId}`, { method: "DELETE" }),
    onSettled: invalidate,
  });
}

/** Admin: `POST /photos/:id/restore` from the trash view. */
export function useRestorePhoto(babyId: string) {
  const invalidate = useInvalidatePhotos(babyId);
  return useMutation({
    mutationFn: (photoId: string) =>
      apiFetch(`/photos/${photoId}/restore`, { method: "POST", schema: photoSummarySchema }),
    onSettled: invalidate,
  });
}

export async function fetchOriginalUrl(photoId: string): Promise<string> {
  const res = await apiFetch(`/photos/${photoId}/original`, { schema: originalUrlResponseSchema });
  return res.url;
}
