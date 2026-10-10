import { NATIVE_UPLOAD_PICK_MAX } from "@tinyglow/shared";
import type { NativeFileRef } from "../uploader";
import { copyIntoUploadCache } from "./files";

// Photo selection (docs/plans/step-9.md 2.6). The library picker returns ORIGINAL files
// (`skipTranscoding: true` keeps HEIC), not re-encoded JPEGs, so FR-2.3 "original kept
// untouched" holds. Each result is copied into app-private cache before the manager sees it.

export type PickOutcome =
  | { status: "picked"; files: NativeFileRef[]; failed: number }
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "error" };

function isCancel(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : "";
  return msg.includes("cancel") || msg.includes("dismiss") || msg.includes("pickerdismissed");
}

function isDenied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : "";
  return msg.includes("permission") || msg.includes("denied");
}

/** Up to `limit` (default and max 500) photos from the library. */
export async function pickPhotos(limit: number = NATIVE_UPLOAD_PICK_MAX): Promise<PickOutcome> {
  try {
    const { FilePicker } = await import("@capawesome/capacitor-file-picker");
    const res = await FilePicker.pickImages({
      limit: Math.min(limit, NATIVE_UPLOAD_PICK_MAX),
      readData: false,
      skipTranscoding: true,
    });
    const files: NativeFileRef[] = [];
    let failed = 0;
    for (const f of res.files) {
      if (!f.path) {
        failed += 1;
        continue;
      }
      try {
        files.push(
          await copyIntoUploadCache({
            path: f.path,
            name: f.name,
            mime: f.mimeType,
            size: f.size,
          }),
        );
      } catch {
        failed += 1;
      }
    }
    if (files.length === 0 && failed === 0) return { status: "cancelled" };
    return { status: "picked", files, failed };
  } catch (e) {
    if (isCancel(e)) return { status: "cancelled" };
    if (isDenied(e)) return { status: "denied" };
    return { status: "error" };
  }
}

/** One photo from the camera at full quality; not saved to the gallery. */
export async function takePhoto(): Promise<PickOutcome> {
  try {
    const { Camera } = await import("@capacitor/camera");
    const shot = await Camera.takePhoto({
      quality: 100,
      saveToGallery: false,
      correctOrientation: true,
    });
    const path = shot.uri ?? shot.webPath;
    if (!path) return { status: "error" };
    const ext = /\.(\w{2,5})$/.exec(path)?.[1]?.toLowerCase() ?? "jpg";
    const { Filesystem } = await import("@capacitor/filesystem");
    const stat = await Filesystem.stat({ path });
    const mime = ext === "png" ? "image/png" : ext === "heic" ? "image/heic" : "image/jpeg";
    const name = `Camera-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    const ref = await copyIntoUploadCache({ path, name, mime, size: stat.size });
    return { status: "picked", files: [ref], failed: 0 };
  } catch (e) {
    if (isCancel(e)) return { status: "cancelled" };
    if (isDenied(e)) return { status: "denied" };
    return { status: "error" };
  }
}
