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
}

export interface Uploader {
  putPart(url: string, blob: Blob, opts?: PutPartOptions): Promise<void>;
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
