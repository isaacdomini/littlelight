import {
  authConfigResponseSchema,
  deletionPreviewResponseSchema,
  membersListResponseSchema,
  originalUrlResponseSchema,
  type PhotosView,
  photoSummarySchema,
  photosListResponseSchema,
  sessionsListResponseSchema,
} from "@littlelight/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch } from "./api";
import { uploadManager } from "./upload/manager";

export function useAuthConfig() {
  return useQuery({
    queryKey: ["auth-config"],
    queryFn: () => apiFetch("/auth/config", { schema: authConfigResponseSchema }),
    staleTime: 5 * 60_000,
  });
}

export const membersKey = (babyId: string) => ["babies", babyId, "members"] as const;

export function useMembers(babyId: string | undefined) {
  return useQuery({
    queryKey: membersKey(babyId ?? "none"),
    enabled: !!babyId,
    queryFn: () => apiFetch(`/babies/${babyId}/members`, { schema: membersListResponseSchema }),
  });
}

export const SESSIONS_KEY = ["auth", "sessions"] as const;
export function useSessions() {
  return useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => apiFetch("/auth/sessions", { schema: sessionsListResponseSchema }),
  });
}

export const DELETION_PREVIEW_KEY = ["me", "deletion-preview"] as const;
export function useDeletionPreview() {
  return useQuery({
    queryKey: DELETION_PREVIEW_KEY,
    queryFn: () => apiFetch("/me/deletion-preview", { schema: deletionPreviewResponseSchema }),
  });
}

// ---- photos (step 4) ---------------------------------------------------------------------

export const photosRoot = (babyId: string) => ["babies", babyId, "photos"] as const;
export const photosKey = (babyId: string, view: PhotosView) =>
  [...photosRoot(babyId), view] as const;

/** Signed thumbnail URLs live 1 h (`urlExpiresAt`); refetch well before they expire. */
const PHOTOS_STALE_MS = 45 * 60_000;

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

/** Refresh every photo list of the baby when uploads are ingested (any page that is mounted). */
export function usePhotosInvalidation() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      uploadManager.onPhotosChanged((babyId) => {
        void queryClient.invalidateQueries({ queryKey: photosRoot(babyId) });
      }),
    [queryClient],
  );
}

export function useApprovePhoto(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      apiFetch(`/photos/${photoId}/approve`, { method: "POST", schema: photoSummarySchema }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: photosRoot(babyId) }),
  });
}

export function useRejectPhoto(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      apiFetch(`/photos/${photoId}/reject`, { method: "POST", schema: photoSummarySchema }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: photosRoot(babyId) }),
  });
}

export function useDeletePhoto(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) => apiFetch(`/photos/${photoId}`, { method: "DELETE" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: photosRoot(babyId) }),
  });
}

export async function fetchOriginalUrl(photoId: string): Promise<string> {
  const res = await apiFetch(`/photos/${photoId}/original`, { schema: originalUrlResponseSchema });
  return res.url;
}
