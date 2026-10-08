import {
  type Measurement,
  type MeasurementCreate,
  type MeasurementKind,
  type MeasurementUpdate,
  measurementSchema,
  measurementsListResponseSchema,
} from "@littlelight/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api";
import { photoKey } from "./photos";

export const measurementsRoot = (babyId: string) => ["babies", babyId, "measurements"] as const;
export const measurementsKey = (babyId: string, kind?: MeasurementKind) =>
  [...measurementsRoot(babyId), kind ?? "all"] as const;

/** Ordered by `measuredAt` ascending; optionally one kind. */
export function useMeasurements(babyId: string | undefined, kind?: MeasurementKind) {
  return useQuery({
    queryKey: measurementsKey(babyId ?? "none", kind),
    enabled: !!babyId,
    staleTime: 60_000,
    queryFn: () =>
      apiFetch(`/babies/${babyId}/measurements${kind ? `?kind=${kind}` : ""}`, {
        schema: measurementsListResponseSchema,
      }),
    select: (d) => d.measurements,
  });
}

function useInvalidateMeasurements(babyId: string) {
  const queryClient = useQueryClient();
  return (photoId?: string | null) => {
    void queryClient.invalidateQueries({ queryKey: measurementsRoot(babyId) });
    // A linked photo shows its measurements in the details panel.
    if (photoId) void queryClient.invalidateQueries({ queryKey: photoKey(photoId) });
    else void queryClient.invalidateQueries({ queryKey: ["photo"] });
  };
}

export function useCreateMeasurement(babyId: string) {
  const invalidate = useInvalidateMeasurements(babyId);
  return useMutation({
    mutationFn: (input: MeasurementCreate): Promise<Measurement> =>
      apiFetch(`/babies/${babyId}/measurements`, {
        method: "POST",
        body: input,
        schema: measurementSchema,
      }),
    onSettled: (_d, _e, vars) => invalidate(vars.photoId),
  });
}

export function useUpdateMeasurement(babyId: string) {
  const invalidate = useInvalidateMeasurements(babyId);
  return useMutation({
    mutationFn: ({ id, ...patch }: MeasurementUpdate & { id: string }): Promise<Measurement> =>
      apiFetch(`/measurements/${id}`, { method: "PATCH", body: patch, schema: measurementSchema }),
    onSettled: () => invalidate(),
  });
}

export function useDeleteMeasurement(babyId: string) {
  const invalidate = useInvalidateMeasurements(babyId);
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/measurements/${id}`, { method: "DELETE" }),
    onSettled: () => invalidate(),
  });
}
