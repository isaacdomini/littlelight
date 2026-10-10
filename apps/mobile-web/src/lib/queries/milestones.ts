import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Milestone,
  type MilestoneCreate,
  type MilestoneUpdate,
  milestoneSchema,
  milestonesListResponseSchema,
} from "@tinyglow/shared";
import { apiFetch } from "../api";
import { photosRoot } from "./photos";

export const milestonesKey = (babyId: string) => ["babies", babyId, "milestones"] as const;

/** Presets plus the baby's custom milestones, with photo counts and cover thumbs. */
export function useMilestones(babyId: string | undefined) {
  return useQuery({
    queryKey: milestonesKey(babyId ?? "none"),
    enabled: !!babyId,
    staleTime: 60_000,
    queryFn: () =>
      apiFetch(`/babies/${babyId}/milestones`, { schema: milestonesListResponseSchema }),
    select: (d) => d.milestones,
  });
}

/** Admin only (server enforced). 409 when the name exists; 403 at the cap. */
export function useCreateMilestone(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MilestoneCreate): Promise<Milestone> =>
      apiFetch(`/babies/${babyId}/milestones`, {
        method: "POST",
        body: input,
        schema: milestoneSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: milestonesKey(babyId) }),
  });
}

export function useUpdateMilestone(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: MilestoneUpdate & { id: string }): Promise<Milestone> =>
      apiFetch(`/milestones/${id}`, { method: "PATCH", body: patch, schema: milestoneSchema }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: milestonesKey(babyId) });
      // Badges and alt text carry the milestone name; refresh anything showing it.
      void queryClient.invalidateQueries({ queryKey: photosRoot(babyId) });
    },
  });
}

export function useDeleteMilestone(babyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/milestones/${id}`, { method: "DELETE" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: milestonesKey(babyId) });
      void queryClient.invalidateQueries({ queryKey: photosRoot(babyId) });
    },
  });
}
