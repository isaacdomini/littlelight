import type { StorageClient } from "../plugins/storage";

// In-memory S3 for the API tests (multipart create / list parts / complete / abort / head). Test
// only. It models just what `storage/multipart.ts` calls; the browser's part PUTs are simulated
// with `putPart`, and `failNext` / `override` script S3 failures. No bytes are stored, only sizes.

export interface S3Call {
  name: string;
  input: Record<string, unknown>;
}

export interface S3Stub extends StorageClient {
  calls: S3Call[];
  /** Multipart uploads in flight, by upload id. */
  uploads: Map<string, { key: string; parts: Map<number, { size: number; etag: string }> }>;
  /** Completed objects (key -> size). */
  objects: Map<string, number>;
  /** Simulate the browser PUTting part `n` (1-based) of the upload for `key`. */
  putPart(key: string, partNumber: number, size: number): void;
  /** Put a finished object directly (e.g. "completed earlier, the multipart is gone"). */
  putObject(key: string, size: number): void;
  /** Forget an in-flight upload without completing it (swept / aborted elsewhere). */
  dropUpload(key: string): void;
  /** Make the next command named `name` throw `err`. */
  failNext(name: string, err: unknown): void;
  /** Make every command named `name` throw `err` until cleared with `undefined`. */
  failAll(name: string, err: unknown | undefined): void;
  count(name: string): number;
}

export const s3Error = (name: string, status?: number) =>
  Object.assign(new Error(name), {
    name,
    ...(status ? { $metadata: { httpStatusCode: status } } : {}),
  });

export function createS3Stub(): S3Stub {
  const calls: S3Call[] = [];
  const uploads: S3Stub["uploads"] = new Map();
  const objects: S3Stub["objects"] = new Map();
  const once = new Map<string, unknown[]>();
  const always = new Map<string, unknown>();
  let seq = 0;

  const byKey = (key: string) => {
    for (const [id, u] of uploads) if (u.key === key) return [id, u] as const;
    return undefined;
  };

  const stub: S3Stub = {
    calls,
    uploads,
    objects,
    destroy: () => undefined,
    putPart(key, partNumber, size) {
      const hit = byKey(key);
      if (!hit) throw new Error(`no multipart upload for ${key}`);
      hit[1].parts.set(partNumber, { size, etag: `"etag-${partNumber}-${size}"` });
    },
    putObject(key, size) {
      objects.set(key, size);
    },
    dropUpload(key) {
      const hit = byKey(key);
      if (hit) uploads.delete(hit[0]);
    },
    failNext(name, err) {
      once.set(name, [...(once.get(name) ?? []), err]);
    },
    failAll(name, err) {
      if (err === undefined) always.delete(name);
      else always.set(name, err);
    },
    count: (name) => calls.filter((c) => c.name === name).length,
    send: (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name.replace(/Command$/, "");
      const input = command.input;
      calls.push({ name, input });
      const queued = once.get(name);
      if (queued?.length) throw queued.shift();
      if (always.has(name)) throw always.get(name);
      const key = input.Key as string;
      switch (name) {
        case "CreateMultipartUpload": {
          const id = `upload-${++seq}`;
          uploads.set(id, { key, parts: new Map() });
          return { UploadId: id };
        }
        case "ListParts": {
          const u = uploads.get(input.UploadId as string);
          if (!u) throw s3Error("NoSuchUpload", 404);
          return {
            IsTruncated: false,
            Parts: [...u.parts.entries()].map(([PartNumber, p]) => ({
              PartNumber,
              Size: p.size,
              ETag: p.etag,
            })),
          };
        }
        case "CompleteMultipartUpload": {
          const id = input.UploadId as string;
          const u = uploads.get(id);
          if (!u) throw s3Error("NoSuchUpload", 404);
          const wanted = (input.MultipartUpload as { Parts: { PartNumber: number }[] }).Parts;
          let size = 0;
          for (const w of wanted) {
            const p = u.parts.get(w.PartNumber);
            if (!p) throw s3Error("InvalidPart", 400);
            size += p.size;
          }
          objects.set(u.key, size);
          uploads.delete(id);
          return {};
        }
        case "AbortMultipartUpload": {
          const id = input.UploadId as string;
          if (!uploads.delete(id)) throw s3Error("NoSuchUpload", 404);
          return {};
        }
        case "HeadObject": {
          const size = objects.get(key);
          if (size === undefined) throw s3Error("NotFound", 404);
          return { ContentLength: size };
        }
        default:
          return {};
      }
    }) as never,
  };
  return stub;
}
