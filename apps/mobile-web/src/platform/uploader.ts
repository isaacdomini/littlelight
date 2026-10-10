// Step-9 seam: a part is a plain HTTPS PUT of a Blob to a presigned URL, with no custom headers,
// so a native background uploader (URLSession / WorkManager) can replace the web implementation
// without any API change.

export class PartUploadError extends Error {
  /** HTTP status of the storage response; 0 for a network failure. */
  readonly status: number;
  constructor(status: number) {
    super(status === 0 ? "network error" : `part upload failed (${status})`);
    this.name = "PartUploadError";
    this.status = status;
  }
}

export interface PutPartOptions {
  /** Bytes of this part sent so far. */
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
  /** Native whole-file PUTs: keep the transfer off the cellular network. */
  wifiOnly?: boolean;
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
}

export interface Uploader {
  putPart(url: string, blob: Blob, opts?: PutPartOptions): Promise<void>;
  /**
   * Native only: PUT the whole file from disk as one raw-body request that keeps running while
   * the app is backgrounded. Used when the file is a single part (<= the part size).
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
