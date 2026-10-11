import { useQuery } from "@tanstack/react-query";
import { babySchema } from "@tinyglow/shared";
import { apiFetch } from "../api";

export const freeTierKey = (babyId: string) => ["babies", babyId, "freeTier"] as const;

/**
 * The album's free-tier pool (`GET /babies/:id` -> `freeTier`; null for Plus or trashed albums).
 * Refetched after uploads and trash changes (see `photosRoot` invalidation).
 */
export function useFreeTier(babyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: freeTierKey(babyId ?? ""),
    enabled: enabled && !!babyId,
    staleTime: 30_000,
    queryFn: async () => (await apiFetch(`/babies/${babyId}`, { schema: babySchema })).freeTier,
  });
}
