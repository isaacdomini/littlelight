import { SHARE_DIR } from "./files";

// Native share sheet and download-to-share (docs/plans/step-9.md 2.7). Signed URLs and file
// paths are never logged.

/** Opens the iOS/Android share sheet for a link. Resolves false when unavailable or dismissed. */
export async function shareLink(opts: {
  url: string;
  title?: string;
  text?: string;
}): Promise<boolean> {
  try {
    const { Share } = await import("@capacitor/share");
    if (!(await Share.canShare()).value) return false;
    await Share.share({
      url: opts.url,
      title: opts.title,
      text: opts.text,
      dialogTitle: opts.title,
    });
    return true;
  } catch {
    return false; // user dismissed the sheet
  }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "photo.jpg";
}

/**
 * Fetches a signed download URL into `Caches/ll-share/`, opens the share sheet with the file
 * (the user picks "Save Image" / another app), then deletes the temp file.
 */
export async function downloadAndShare(signedUrl: string, fileName: string): Promise<boolean> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  let path = `${SHARE_DIR}/${Date.now().toString(36)}-${safeName(fileName)}`;
  try {
    await Filesystem.mkdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true }).catch(
      () => undefined,
    );
    const res = await fetch(signedUrl, { credentials: "omit" });
    if (!res.ok) return false;
    const blob = await res.blob();
    // A name without an extension takes one from the stored content type (iOS picks "Save
    // Image" by file type), so HEIC originals keep their real extension.
    if (!/\.[A-Za-z0-9]{2,5}$/.test(path)) path += extensionFor(blob.type);
    const data = await blobToBase64(blob);
    const written = await Filesystem.writeFile({ path, data, directory: Directory.Cache });
    try {
      await Share.share({ files: [written.uri] });
    } catch {
      // dismissed
    }
    return true;
  } catch {
    return false;
  } finally {
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
  }
}

function extensionFor(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/heic":
    case "image/heif":
      return ".heic";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".jpg";
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Streams a large signed download (an export ZIP) to `Caches/ll-share/` with the native
 * downloader, opens the share sheet ("Save to Files", AirDrop, another app), then deletes the
 * file. Unlike `downloadAndShare` it never loads the bytes into the WebView (that path builds a
 * Blob plus a base64 copy, which cannot hold a multi-GB ZIP). The URL and path are never logged.
 */
export async function downloadLargeAndShare(signedUrl: string, fileName: string): Promise<boolean> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  const path = `${SHARE_DIR}/${Date.now().toString(36)}-${safeName(fileName)}`;
  try {
    await Filesystem.mkdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true }).catch(
      () => undefined,
    );
    const done = await Filesystem.downloadFile({
      url: signedUrl,
      path,
      directory: Directory.Cache,
    });
    if (!done.path) return false;
    try {
      await Share.share({
        files: [done.path.startsWith("file:") ? done.path : `file://${done.path}`],
      });
    } catch {
      // dismissed
    }
    return true;
  } catch {
    return false;
  } finally {
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
  }
}
