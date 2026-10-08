import type { Photo, PhotoDetailsPatch } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { patchCachedPhotos, photoKey, useUpdatePhotoDetails } from "../../lib/queries/photos";

/**
 * Saves details with an optimistic cache update (detail + grid badge), rolling back on failure.
 * Notes and people only ever travel in the request body.
 */
export function useOptimisticDetails(babyId: string) {
  const queryClient = useQueryClient();
  const update = useUpdatePhotoDetails(babyId);
  return async (id: string, patch: PhotoDetailsPatch): Promise<void> => {
    const key = photoKey(id);
    const previous = queryClient.getQueryData<Photo>(key);
    if (previous) {
      const details = {
        milestoneId: previous.details?.milestoneId ?? null,
        note: previous.details?.note ?? null,
        people: previous.details?.people ?? [],
        locationLabel: previous.details?.locationLabel ?? null,
      };
      if (patch.milestoneId !== undefined) details.milestoneId = patch.milestoneId;
      if (patch.note !== undefined) details.note = patch.note;
      if (patch.people !== undefined) details.people = patch.people;
      if (patch.locationLabel !== undefined) details.locationLabel = patch.locationLabel;
      queryClient.setQueryData<Photo>(key, {
        ...previous,
        milestoneId: details.milestoneId,
        details,
      });
      patchCachedPhotos(queryClient, babyId, (p) =>
        p.id === id ? { ...p, milestoneId: details.milestoneId } : undefined,
      );
    }
    try {
      await update.mutateAsync({ id, ...patch });
    } catch (e) {
      if (previous) {
        queryClient.setQueryData<Photo>(key, previous);
        patchCachedPhotos(queryClient, babyId, (p) =>
          p.id === id ? { ...p, milestoneId: previous.milestoneId } : undefined,
        );
      }
      throw e;
    }
  };
}
