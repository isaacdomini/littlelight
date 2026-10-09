import {
  aiRetryResponseSchema,
  aiUsageResponseSchema,
  type Photo,
  type PhotoAiOverridePatch,
  photoSchema,
} from "@littlelight/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { patchCachedPhotos, photoKey } from "./photos";

export const aiUsageKey = (babyId: string) => ["babies", babyId, "ai-usage"] as const;

/** `PATCH /photos/:id/ai` (admins). Override values travel only in the body, never logged. */
export function useUpdateAiOverrides(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: PhotoAiOverridePatch & { id: string }): Promise<Photo> =>
      apiFetch(`/photos/${id}/ai`, { method: "PATCH", body: patch, schema: photoSchema }),
    onSuccess: (photo) => {
      queryClient.setQueryData(photoKey(photo.id), photo);
      patchCachedPhotos(queryClient, babyId, (p) =>
        p.id === photo.id ? { ...p, caption: photo.caption, aiStatus: photo.aiStatus } : undefined,
      );
    },
  });
}

/** `POST /photos/:id/ai/retry` (admins, failed photos only); the photo goes back to pending. */
export function useRetryAi(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/photos/${id}/ai/retry`, { method: "POST", schema: aiRetryResponseSchema }),
    onSuccess: (res, id) => {
      queryClient.setQueryData<Photo>(photoKey(id), (old) =>
        old
          ? { ...old, aiStatus: res.status, ai: { ...old.ai, status: res.status, canRetry: false } }
          : old,
      );
      patchCachedPhotos(queryClient, babyId, (p) =>
        p.id === id ? { ...p, aiStatus: res.status } : undefined,
      );
      void queryClient.invalidateQueries({ queryKey: photoKey(id) });
      void queryClient.invalidateQueries({ queryKey: aiUsageKey(babyId) });
    },
  });
}

/** `GET /babies/:id/ai/usage` (admins): this month's cost and per-status counts. */
export function useAiUsage(babyId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: aiUsageKey(babyId ?? "none"),
    enabled: !!babyId && enabled,
    staleTime: 60_000,
    queryFn: () => apiFetch(`/babies/${babyId}/ai/usage`, { schema: aiUsageResponseSchema }),
  });
}
