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
  return "jpg";
}

/** Copies a picker/camera file into `Caches/ll-uploads` and returns the stable reference. */
export async function copyIntoUploadCache(src: {
  path: string;
  name: string;
  mime: string;
  size: number;
}): Promise<NativeFileRef> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  await Filesystem.mkdir({ path: UPLOAD_DIR, directory: Directory.Cache, recursive: true }).catch(
    () => undefined,
  );
  const to = `${UPLOAD_DIR}/${newId()}.${extensionOf(src.name, src.mime)}`;
  const res = await Filesystem.copy({ from: src.path, to, toDirectory: Directory.Cache });
  return { path: res.uri, name: src.name, mime: src.mime, size: src.size };
}

/** Reads one working copy into a `File` (for SHA-256 + EXIF; never kept longer than needed). */
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
