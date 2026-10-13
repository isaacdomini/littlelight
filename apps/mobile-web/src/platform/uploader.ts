// Step-9 seam: a part is a plain HTTPS PUT of a Blob to a presigned URL, with no custom headers,
// so a native background uploader (URLSession / WorkManager) can replace the web implementation
// without any API change.

/**
 * Native uploader refusals that no retry can fix (step 12 follow-up): `no-space` = not enough
 * free disk for the part copy; `bad-range` = the requested byte range is outside the file (it
 * changed or vanished since it was picked). Anything else is a plain transport failure.
 */
export type PartUploadReason = "no-space" | "bad-range";

export class PartUploadError extends Error {
  /** HTTP status of the storage response; 0 for a network failure or a local refusal. */
  readonly status: number;
  /** Set for a non-retryable local refusal from the native uploader. */
  readonly reason: PartUploadReason | null;
  constructor(status: number, reason: PartUploadReason | null = null) {
    super(
      reason
        ? `part upload refused (${reason})`
        : status === 0
          ? "network error"
          : `part upload failed (${status})`,
    );
    this.name = "PartUploadError";
    this.status = status;
    this.reason = reason;
  }
}

export interface PutPartOptions {
  /** Bytes of this part sent so far. */
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
  /** Native PUTs: keep the transfer off the cellular network. */
  wifiOnly?: boolean;
  /** Native ranged part (step 12): first byte of the part in the file; default 0. */
  offset?: number;
  /** Native ranged part: bytes in this part; default "to the end of the file". */
  length?: number;
}

/** A picked or captured file on the device, copied into app-private storage (native only). */
export interface NativeFileRef {
  /** File URI/path inside the app cache (`Caches/ll-uploads/…`). Never logged. */
  path: string;
  name: string;
  mime: string;
  size: number;
  /** Lowercase hex SHA-256 when the platform already computed it (album sync). */
  sha256?: string;
  /** ISO capture time from the platform (album sync); a hint, the server re-reads EXIF. */
  takenAt?: string;
  /** A video's duration in ms when the platform picker/sync reported it (step 12); a hint. */
  durationMs?: number;
}

export interface Uploader {
  putPart(url: string, blob: Blob, opts?: PutPartOptions): Promise<void>;
  /**
   * Native only: PUT one part (`opts.offset` / `opts.length`; the whole file when omitted) from
   * disk as one raw-body request that keeps running while the app is backgrounded. The manager
   * calls it once per part, resuming from the api's `uploadedPartNumbers` (NATIVE.md "Uploads").
   */
  putFile?(url: string, file: NativeFileRef, opts?: PutPartOptions): Promise<void>;
}

/** Web implementation: XMLHttpRequest, because `fetch` has no upload progress events. */
export const webUploader: Uploader = {
  putPart(url, blob, opts = {}) {
    return new Promise<void>((resolve, reject) => {
      const { onProgress, signal } = opts;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const xhr = new XMLHttpRequest();
      const onAbort = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort);
      xhr.open("PUT", url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded);
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(blob.size);
          resolve();
        } else {
          reject(new PartUploadError(xhr.status));
        }
      };
      xhr.onerror = () => {
        cleanup();
        reject(new PartUploadError(0));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      xhr.send(blob);
    });
  },
};

let current: Uploader = webUploader;
export function getUploader(): Uploader {
  return current;
}
/** Step 9 registers the native implementation here; tests inject fakes. */
export function setUploader(u: Uploader): void {
  current = u;
}
