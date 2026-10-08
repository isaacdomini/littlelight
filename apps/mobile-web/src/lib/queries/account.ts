import {
  authConfigResponseSchema,
  deletionPreviewResponseSchema,
  membersListResponseSchema,
  sessionsListResponseSchema,
} from "@littlelight/shared";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";

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
