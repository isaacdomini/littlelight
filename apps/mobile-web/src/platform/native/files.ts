import { readVideoDurationFromUrl } from "../../lib/upload/validate";
import { convertFileSrc } from "../platform";
import type { NativeFileRef } from "../uploader";

// App-private working copies of picked/captured photos (docs/plans/step-9.md 2.6). Picker temp
// files can vanish while the app is suspended, so each pick is copied to
// `Caches/ll-uploads/<id>.<ext>`; the copy is deleted when its upload ends and on sign-out.
// Paths, names and EXIF are never logged.

export const UPLOAD_DIR = "ll-uploads";
export const SHARE_DIR = "ll-share";

let counter = 0;
function newId(): string {
  counter += 1;
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${Date.now().toString(36)}-${counter}-${rand[0]?.toString(36)}${rand[1]?.toString(36)}`;
}

function extensionOf(name: string, mime: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  if (m?.[1]) return m[1].toLowerCase();
  if (mime === "image/heic" || mime === "image/heif") return "heic";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/mp4") return "mp4";
  return "jpg";
}

async function uploadCacheTarget(src: { name: string; mime: string }) {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  await Filesystem.mkdir({ path: UPLOAD_DIR, directory: Directory.Cache, recursive: true }).catch(
    () => undefined,
  );
  return {
    Filesystem,
    Directory,
    to: `${UPLOAD_DIR}/${newId()}.${extensionOf(src.name, src.mime)}`,
  };
}

/** Copies a picker/camera file into `Caches/ll-uploads` and returns the stable reference. */
export async function copyIntoUploadCache(src: {
  path: string;
  name: string;
  mime: string;
  size: number;
  durationMs?: number;
}): Promise<NativeFileRef> {
  const { Filesystem, Directory, to } = await uploadCacheTarget(src);
  const res = await Filesystem.copy({ from: src.path, to, toDirectory: Directory.Cache });
  return {
    path: res.uri,
    name: src.name,
    mime: src.mime,
    size: src.size,
    ...(src.durationMs !== undefined ? { durationMs: src.durationMs } : {}),
  };
}

/**
 * Moves a picker temp file into `Caches/ll-uploads` (videos, step 12 / NATIVE.md "Picking
 * videos"): the picker already made one temp copy, so a 2 GB clip never needs a second one.
 * Falls back to a copy when the rename fails (another volume).
 */
export async function moveIntoUploadCache(src: {
  path: string;
  name: string;
  mime: string;
  size: number;
  durationMs?: number;
}): Promise<NativeFileRef> {
  const { Filesystem, Directory, to } = await uploadCacheTarget(src);
  try {
    await Filesystem.rename({ from: src.path, to, toDirectory: Directory.Cache });
  } catch {
    return copyIntoUploadCache(src);
  }
  const { uri } = await Filesystem.getUri({ path: to, directory: Directory.Cache });
  return {
    path: uri,
    name: src.name,
    mime: src.mime,
    size: src.size,
    ...(src.durationMs !== undefined ? { durationMs: src.durationMs } : {}),
  };
}

/**
 * A native video's duration (ms) without reading the clip: a `<video preload="metadata">` on the
 * WebView file URL (`convertFileSrc`), which streams by range. Capacitor iOS answers a full-file
 * `fetch` of a mov/mp4 with a plain `URLResponse` (status 0), so `fileFromRef` must never be used
 * for videos; the native ranged `putFile` streams the bytes from disk instead.
 */
export function nativeVideoDuration(ref: NativeFileRef): Promise<number | undefined> {
  try {
    return readVideoDurationFromUrl(convertFileSrc(ref.path));
  } catch {
    return Promise.resolve(undefined);
  }
}

/**
 * Reads one working copy into a `File` (photos only: SHA-256 + EXIF; never kept longer than
 * needed). Not for videos, see `nativeVideoDuration`.
 */
export async function fileFromRef(ref: NativeFileRef): Promise<File> {
  const res = await fetch(convertFileSrc(ref.path));
  if (!res.ok) throw new Error("native file unreadable");
  const blob = await res.blob();
  return new File([blob], ref.name, { type: ref.mime });
}

async function deletePath(path: string): Promise<void> {
  const { Filesystem } = await import("@capacitor/filesystem");
  await Filesystem.deleteFile({ path }).catch(() => undefined);
}

export async function deleteNativeCopy(ref: NativeFileRef): Promise<void> {
  await deletePath(ref.path);
}

/** Removes every working copy (sign-out, account deletion, app start). */
export async function wipeNativeFiles(): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  for (const dir of [UPLOAD_DIR, SHARE_DIR]) {
    await Filesystem.rmdir({ path: dir, directory: Directory.Cache, recursive: true }).catch(
      () => undefined,
    );
  }
}
