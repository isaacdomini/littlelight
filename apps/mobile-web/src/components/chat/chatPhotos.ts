import type { ChatPhoto, PhotoSummary } from "@tinyglow/shared";

/** Fills the summary fields a chat photo lacks so the shared `Thumb` and viewer can use it. */
export function chatPhotoToSummary(p: ChatPhoto): PhotoSummary {
  return {
    ...p,
    status: "ready",
    approval: "approved",
    takenAtEstimated: false,
    width: null,
    height: null,
    mime: null,
    // Step 12: older stored grids carry no media fields; treat them as photos.
    mediaKind: p.mediaKind ?? "photo",
    durationMs: p.durationMs ?? null,
    renditionStatus: p.mediaKind === "video" ? "ready" : "none",
    duplicateOfPhotoId: null,
    uploadedBy: null,
    createdAt: p.takenAt ?? new Date(0).toISOString(),
    deletedAt: null,
    aiStatus: "ready",
  };
}
