import { useQuery } from "@tanstack/react-query";
import { type ImportSource, importSourcesListResponseSchema } from "@tinyglow/shared";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { nativePlatform } from "../../platform/platform";
import { apiFetch } from "../api";

export const importSourcesKey = (babyId: string) => ["babies", babyId, "import-sources"] as const;

/**
 * Apple Photos album sync is offered to admins in the iPhone app only (user decision, plan D1).
 * The server enforces the role as well; this only decides whether to show the controls.
 */
export function useAppleSyncAvailable(): boolean {
  const { baby } = useCurrentBaby();
  return nativePlatform() === "ios" && baby?.role === "admin";
}

/**
 * This phone's `import_sources` row for a baby (status and counters), or `null` when none or when
 * the endpoint is unavailable. Never throws: the card still works from its local state.
 */
export function useThisDeviceImportSource(babyId: string | undefined, enabled = true) {
  return useQuery<ImportSource | null>({
    queryKey: importSourcesKey(babyId ?? "none"),
    enabled: !!babyId && enabled,
    retry: false,
    staleTime: 15_000,
    queryFn: async () => {
      try {
        const { getInstallId } = await import("../../platform/native/installId");
        const deviceId = await getInstallId();
        const res = await apiFetch(`/me/import-sources?babyId=${babyId}&deviceId=${deviceId}`, {
          schema: importSourcesListResponseSchema,
        });
        return res.sources.find((s) => s.isThisDevice) ?? null;
      } catch {
        return null;
      }
    },
  });
}
