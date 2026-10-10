import { useQuery } from "@tanstack/react-query";
import {
  type CreateExportRequest,
  type DataExport,
  exportDownloadUrlResponseSchema,
  exportResponseSchema,
  exportsListResponseSchema,
} from "@tinyglow/shared";
import { apiFetch } from "../api";

export const exportsKey = (babyId: string) => ["babies", babyId, "exports"] as const;

/** True while the worker still has work to do on this export. */
export const isActiveExport = (e: DataExport) => e.status === "queued" || e.status === "running";

const POLL_MS = 3000;

/** The album's last exports. Polls only while one is queued or running, then stops. */
export function useExports(babyId: string | undefined) {
  return useQuery({
    queryKey: exportsKey(babyId ?? "none"),
    enabled: !!babyId,
    queryFn: () => apiFetch(`/babies/${babyId}/exports`, { schema: exportsListResponseSchema }),
    refetchInterval: (q) => (q.state.data?.exports.some(isActiveExport) ? POLL_MS : false),
  });
}

export const requestExport = (babyId: string, body: CreateExportRequest) =>
  apiFetch(`/babies/${babyId}/exports`, { method: "POST", body, schema: exportResponseSchema });

/** The signed URL is used at once by the caller and never stored. */
export const mintExportUrl = (babyId: string, exportId: string) =>
  apiFetch(`/babies/${babyId}/exports/${exportId}/download-url`, {
    method: "POST",
    schema: exportDownloadUrlResponseSchema,
  });

export const deleteExport = (babyId: string, exportId: string) =>
  apiFetch(`/babies/${babyId}/exports/${exportId}`, { method: "DELETE" });
