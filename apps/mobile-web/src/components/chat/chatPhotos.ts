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
    duplicateOfPhotoId: null,
    uploadedBy: null,
    createdAt: p.takenAt ?? new Date(0).toISOString(),
    deletedAt: null,
    aiStatus: "ready",
  };
}
