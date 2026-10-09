import {
  type PhotoShareLinksResponse,
  photoShareLinksResponseSchema,
  type ShareLinkCreatedResponse,
  type ShareLinkPatchRequest,
  type ShareLinkPhotosAddResponse,
  type ShareLinkPhotosResponse,
  type ShareLinksResponse,
  type ShareRuleInput,
  shareLinkCreatedResponseSchema,
  type shareLinkCreateRequestSchema,
  shareLinkPhotosAddResponseSchema,
  shareLinkPhotosRemoveResponseSchema,
  shareLinkPhotosResponseSchema,
  shareLinksResponseSchema,
} from "@littlelight/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { apiFetch } from "../api";

// Parent side of sharing (docs/plans/step-8.md 2.5). Admins only: the server answers 403 to
// contributors. The one-time URL comes back from create/regenerate and is never cached here:
// callers keep it in component state only.

export type ShareLinkCreateInput = z.input<typeof shareLinkCreateRequestSchema>;

export const shareLinksKey = (babyId: string) => ["babies", babyId, "share-links"] as const;
export const shareLinkPhotosKey = (linkId: string) => ["share-links", linkId, "photos"] as const;
export const photoShareLinksKey = (photoId: string) => ["photos", photoId, "share-links"] as const;

export function useShareLinks(babyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: shareLinksKey(babyId ?? "none"),
    enabled: !!babyId && enabled,
    staleTime: 15_000,
    queryFn: (): Promise<ShareLinksResponse> =>
      apiFetch(`/babies/${babyId}/share-links`, { schema: shareLinksResponseSchema }),
    select: (d) => d.links,
  });
}

export function useCreateShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ShareLinkCreateInput): Promise<ShareLinkCreatedResponse> =>
      apiFetch(`/babies/${babyId}/share-links`, {
        method: "POST",
        body: input,
        schema: shareLinkCreatedResponseSchema,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function usePatchShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: ShareLinkPatchRequest & { id: string }) =>
      apiFetch(`/share-links/${id}`, { method: "PATCH", body: patch }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function useRenewShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ttlHours }: { id: string; ttlHours?: number }) =>
      apiFetch(`/share-links/${id}/renew`, {
        method: "POST",
        body: ttlHours ? { ttlHours } : {},
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function useRegenerateShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<ShareLinkCreatedResponse> =>
      apiFetch(`/share-links/${id}/regenerate`, {
        method: "POST",
        body: {},
        schema: shareLinkCreatedResponseSchema,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function useRevokeShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/share-links/${id}/revoke`, { method: "POST", body: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function useDeleteShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/share-links/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function useSaveShareRule(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rule }: { id: string; rule: ShareRuleInput }) =>
      apiFetch(`/share-links/${id}/rule`, { method: "PUT", body: rule }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

export function useRemoveShareRule(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/share-links/${id}/rule`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: shareLinksKey(babyId) }),
  });
}

/** The shared album of one link (parents' view), newest first, keyset paged. */
export function useShareLinkPhotos(linkId: string | undefined) {
  return useInfiniteQuery({
    queryKey: shareLinkPhotosKey(linkId ?? "none"),
    enabled: !!linkId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<ShareLinkPhotosResponse> =>
      apiFetch(
        `/share-links/${linkId}/photos?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { schema: shareLinkPhotosResponseSchema },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAddToShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      linkId,
      photoIds,
      showSensitive,
    }: {
      linkId: string;
      photoIds: string[];
      showSensitive: boolean;
    }): Promise<ShareLinkPhotosAddResponse> =>
      apiFetch(`/share-links/${linkId}/photos`, {
        method: "POST",
        body: { photoIds, showSensitive },
        schema: shareLinkPhotosAddResponseSchema,
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: shareLinksKey(babyId) });
      void qc.invalidateQueries({ queryKey: shareLinkPhotosKey(v.linkId) });
      for (const id of v.photoIds) void qc.invalidateQueries({ queryKey: photoShareLinksKey(id) });
    },
  });
}

export function useRemoveFromShareLink(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, photoIds }: { linkId: string; photoIds: string[] }) =>
      apiFetch(`/share-links/${linkId}/photos/remove`, {
        method: "POST",
        body: { photoIds },
        schema: shareLinkPhotosRemoveResponseSchema,
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: shareLinksKey(babyId) });
      void qc.invalidateQueries({ queryKey: shareLinkPhotosKey(v.linkId) });
      for (const id of v.photoIds) void qc.invalidateQueries({ queryKey: photoShareLinksKey(id) });
    },
  });
}

export function useShowSensitive(babyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      linkId,
      photoId,
      showSensitive,
    }: {
      linkId: string;
      photoId: string;
      showSensitive: boolean;
    }) =>
      apiFetch(`/share-links/${linkId}/photos/${photoId}`, {
        method: "PATCH",
        body: { showSensitive },
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: shareLinksKey(babyId) });
      void qc.invalidateQueries({ queryKey: shareLinkPhotosKey(v.linkId) });
    },
  });
}

/** Which of the baby's links hold this photo (the add/remove sheet's checked state). */
export function usePhotoShareLinks(photoId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: photoShareLinksKey(photoId ?? "none"),
    enabled: !!photoId && enabled,
    staleTime: 0,
    queryFn: (): Promise<PhotoShareLinksResponse> =>
      apiFetch(`/photos/${photoId}/share-links`, { schema: photoShareLinksResponseSchema }),
    select: (d) => d.links,
  });
}
