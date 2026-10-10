import {
  type GoogleConnection,
  type GoogleConnectReturnPath,
  googleConnectionSchema,
  googleConnectResponseSchema,
  IMPORT_BATCH_ACTIVE_STATUSES,
  type ImportBatch,
  type ImportBatchCreateResponse,
  importBatchCreateResponseSchema,
  importBatchesListResponseSchema,
  importBatchResponseSchema,
} from "@littlelight/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isNative } from "../platform/platform";
import { ApiError, apiFetch, isApiError } from "./api";

// Google Photos import (docs/plans/step-10.md 2.5, 2.6, D14, D15). Nothing here logs or stores the
// consent or picker URLs: they are opened at once and dropped.

export const googleConnectionKey = ["me", "import", "google"] as const;
export const importsKey = (babyId: string) => ["babies", babyId, "imports"] as const;

const UNAVAILABLE: GoogleConnection = {
  available: false,
  connected: false,
  connectedAt: null,
  needsReconnect: false,
};

/** Connection state. A 404 `feature_unavailable` (provider off) reads as "not available". */
export function useGoogleConnection(enabled = true) {
  return useQuery<GoogleConnection>({
    queryKey: googleConnectionKey,
    enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        return await apiFetch("/me/import/google/connection", { schema: googleConnectionSchema });
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.code === "feature_unavailable")) {
          return UNAVAILABLE;
        }
        throw e;
      }
    },
  });
}

export const isActiveBatch = (b: Pick<ImportBatch, "status">): boolean =>
  (IMPORT_BATCH_ACTIVE_STATUSES as readonly string[]).includes(b.status);

/** Recent import batches of a baby (newest first). Polls only while one is active. */
export function useRecentImports(babyId: string | undefined, enabled = true, limit = 5) {
  return useQuery({
    queryKey: [...importsKey(babyId ?? "none"), limit],
    enabled: !!babyId && enabled,
    retry: false,
    queryFn: async () =>
      (
        await apiFetch(`/babies/${babyId}/imports?limit=${limit}`, {
          schema: importBatchesListResponseSchema,
        })
      ).batches,
    refetchInterval: (q) => {
      const active = q.state.data?.find(isActiveBatch);
      return active ? Math.max(3, active.pollIntervalSec) * 1000 : false;
    },
  });
}

/** One batch; refetches at the server's `pollIntervalSec` while it is active (D19). */
export function useImportBatch(batchId: string | null) {
  return useQuery({
    queryKey: ["imports", batchId ?? "none"],
    enabled: !!batchId,
    retry: false,
    staleTime: 0,
    queryFn: async () =>
      (await apiFetch(`/imports/${batchId}`, { schema: importBatchResponseSchema })).batch,
    refetchInterval: (q) => {
      const b = q.state.data;
      if (!b || !isActiveBatch(b)) return false;
      return Math.max(3, b.pollIntervalSec) * 1000;
    },
  });
}

export async function createImport(babyId: string): Promise<ImportBatchCreateResponse> {
  return apiFetch(`/babies/${babyId}/imports/google`, {
    method: "POST",
    body: {},
    schema: importBatchCreateResponseSchema,
  });
}

export async function cancelImport(batchId: string): Promise<ImportBatch> {
  return (
    await apiFetch(`/imports/${batchId}/cancel`, {
      method: "POST",
      schema: importBatchResponseSchema,
    })
  ).batch;
}

export async function disconnectGoogle(): Promise<void> {
  await apiFetch("/me/import/google/connection", { method: "DELETE" });
}

export async function requestConnectUrl(returnTo: GoogleConnectReturnPath): Promise<string> {
  const res = await apiFetch("/me/import/google/connect", {
    method: "POST",
    body: { client: isNative() ? "native" : "web", returnTo },
    schema: googleConnectResponseSchema,
  });
  return res.url;
}

// ---------------------------------------------------------------------------------------------
// Opening Google's pages
// ---------------------------------------------------------------------------------------------

/**
 * A window opened inside the click handler, before the awaited API call, so the popup blocker
 * lets it through; it is pointed at the real URL once known. Null on native (the system browser
 * is used instead) or when the browser refused.
 */
export function preopenWindow(): Window | null {
  if (isNative()) return null;
  const w = window.open("about:blank", "_blank");
  if (w) {
    try {
      w.opener = null;
    } catch {
      // nothing to do
    }
  }
  return w;
}

/**
 * Opens `url`: the pre-opened tab on the web, `@capacitor/browser` on native (Google refuses
 * embedded web views, so never the app's own WebView). Returns false when nothing could open it
 * (blocked popup), so the caller can show a link the user taps.
 */
export async function openExternal(url: string, pre: Window | null): Promise<boolean> {
  if (isNative()) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "popover" });
    return true;
  }
  if (pre && !pre.closed) {
    pre.location.href = url;
    return true;
  }
  return window.open(url, "_blank", "noopener") !== null;
}

/** Closes a pre-opened tab that was never used (the API call failed). */
export function discardWindow(pre: Window | null) {
  try {
    pre?.close();
  } catch {
    // nothing to do
  }
}

/**
 * Runs `cb` whenever the user comes back to the app: tab focus or visibility on the web, the
 * system browser being closed or the app resuming on native (D15: no deep link involved).
 */
export function onReturnToApp(cb: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") cb();
  };
  window.addEventListener("focus", cb);
  document.addEventListener("visibilitychange", onVisible);
  let removeNative: (() => void) | null = null;
  let disposed = false;
  if (isNative()) {
    void (async () => {
      try {
        const [{ Browser }, { App }] = await Promise.all([
          import("@capacitor/browser"),
          import("@capacitor/app"),
        ]);
        const handles = await Promise.all([
          Browser.addListener("browserFinished", cb),
          App.addListener("resume", cb),
        ]);
        if (disposed) for (const h of handles) void h.remove();
        else removeNative = () => handles.forEach((h) => void h.remove());
      } catch {
        // focus/visibility still cover most cases
      }
    })();
  }
  return () => {
    disposed = true;
    window.removeEventListener("focus", cb);
    document.removeEventListener("visibilitychange", onVisible);
    removeNative?.();
  };
}

/** Re-checks the connection and the imports each time the user returns to the app. */
export function useRefreshOnReturn(babyId: string | undefined) {
  const qc = useQueryClient();
  useEffect(
    () =>
      onReturnToApp(() => {
        void qc.invalidateQueries({ queryKey: googleConnectionKey });
        if (babyId) void qc.invalidateQueries({ queryKey: importsKey(babyId) });
        void qc.invalidateQueries({ queryKey: ["imports"] });
      }),
    [qc, babyId],
  );
}

/** i18n key of a friendly message for an import API failure. */
export function importErrorKey(e: unknown) {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "google_not_connected":
        return "google.err.not_connected" as const;
      case "google_reconnect":
        return "google.err.reconnect" as const;
      case "import_in_progress":
        return "google.err.in_progress" as const;
      case "baby_trashed":
        return "google.err.trashed" as const;
      case "rate_limited":
        return "google.err.rate_limited" as const;
      case "forbidden":
        return "google.err.forbidden" as const;
      case "network":
        return "google.err.network" as const;
    }
  }
  return "google.err.generic" as const;
}
