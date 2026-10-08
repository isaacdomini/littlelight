import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  ACCEPTED_UPLOAD_MIMES,
  type PhotoMime,
  UPLOAD_MAX_FILE_BYTES,
} from "@littlelight/shared";

export type RejectReason = "unsupported" | "too_large";

/** `accept` attribute for the file input. */
export const FILE_ACCEPT = [...ACCEPTED_UPLOAD_EXTENSIONS, ...ACCEPTED_UPLOAD_MIMES].join(",");

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

export function acceptedMime(type: string): PhotoMime | undefined {
  const t = type.toLowerCase();
  return (ACCEPTED_UPLOAD_MIMES as readonly string[]).includes(t) ? (t as PhotoMime) : undefined;
}

/**
 * Client-side gate (UX only; the server and worker re-check). HEIC often arrives with an empty
 * mime, so a known extension or a known mime is enough, but a non-image mime is rejected.
 */
export function validateFile(file: {
  name: string;
  size: number;
  type: string;
}): RejectReason | null {
  const extOk = (ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));
  const mimeOk = acceptedMime(file.type) !== undefined;
  const nonImage = file.type !== "" && !file.type.toLowerCase().startsWith("image/");
  if (file.size < 1 || nonImage || !(extOk || mimeOk)) return "unsupported";
  if (file.size > UPLOAD_MAX_FILE_BYTES) return "too_large";
  return null;
}
