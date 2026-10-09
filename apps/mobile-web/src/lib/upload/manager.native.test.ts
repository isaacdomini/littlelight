import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartUploadError, type Uploader } from "../../platform/uploader";
import { ApiError } from "../api";
import { type UploadItem, UploadManager } from "./manager";

// UploadManager with native file references (docs/plans/step-9.md 2.6, 2.15): single-part files
// go to the background uploader straight from disk (`putFile`), multi-part files fall back to
// `putPart` with blobs, rejected files never reach the API, working copies are released.

// The manager imports this module lazily, once per released copy, without awaiting. The test
// runner only applies the mock to the FIRST of several such overlapping imports, so tests that
// assert on releases use one copy at a time (or assert "at least one").
const files = vi.hoisted(() => ({
  fileFromRef: vi.fn(),
  deleteNativeCopy: vi.fn(),
}));
vi.mock("../../platform/native/files", () => files);
vi.mock("./hash", () => ({ sha256Hex: vi.fn(async () => "a".repeat(64)) }));
vi.mock("./exif", () => ({ readCaptureHint: vi.fn(async () => ({})) }));

const api = {
  calls: [] as { path: string; method: string; body: unknown }[],
  handler: (_: string, __: string, ___: unknown): unknown => undefined,
};
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      api.calls.push({ path, method: opts.method ?? "GET", body: opts.body });
      return api.handler(path, opts.method ?? "GET", opts.body);
    }),
  };
});

const BABY = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const PART = 16 * 1024 * 1024;
const ref = (over: Partial<{ path: string; name: string; mime: string; size: number }> = {}) => ({
  path: "file:///cache/ll-uploads/x.jpg",
  name: "IMG_0001.jpg",
  mime: "image/jpeg",
  size: 1_000_000,
  ...over,
});

/** A scripted API: one session, files registered with `partsFor(size)` presigned URLs. */
function scriptApi(
  opts: { partSize?: number; completeState?: string; failComplete?: boolean } = {},
) {
  const partSize = opts.partSize ?? PART;
  const registered = new Map<string, { size: number; clientId: string }>();
  api.handler = (path, method, body) => {
    if (path === `/babies/${BABY}/uploads`) return { id: SESSION };
    if (path === `/uploads/${SESSION}/files` && method === "POST") {
      const reqFiles = (body as { files: { clientId: string; bytes: number }[] }).files;
      return {
        files: reqFiles.map((f, i) => {
          const id = `f${i}-${registered.size}`;
          registered.set(id, { size: f.bytes, clientId: f.clientId });
          const n = Math.max(1, Math.ceil(f.bytes / partSize));
          return {
            id,
            clientId: f.clientId,
            state: "registered",
            partSize,
            parts: Array.from({ length: n }, (_, k) => ({
              partNumber: k + 1,
              url: `https://s.example.test/p${k + 1}?sig=1`,
            })),
          };
        }),
      };
    }
    if (path.endsWith("/parts")) {
      const id = path.split("/")[4] ?? "";
      const n = Math.max(1, Math.ceil((registered.get(id)?.size ?? 1) / partSize));
      return {
        parts: Array.from({ length: n }, (_, k) => ({
          partNumber: k + 1,
          url: `https://s.example.test/p${k + 1}?sig=2`,
        })),
        uploadedPartNumbers: [],
      };
    }
    if (path.endsWith("/complete")) {
      if (opts.failComplete) throw new ApiError(500, "internal", "x");
      return { id: path.split("/")[4], state: opts.completeState ?? "ingested" };
    }
    if (path.endsWith("/finish")) return { id: SESSION };
    if (path === `/uploads/${SESSION}`) return { id: SESSION, files: [], finishedAt: null };
    return undefined;
  };
}

function fakeUploader(over: Partial<Uploader> = {}) {
  const putPart = vi.fn(async (_u: string, _b: Blob, o?: { onProgress?: (n: number) => void }) => {
    o?.onProgress?.(1);
  });
  const putFile = vi.fn(
    async (
      _u: string,
      _f: unknown,
      o?: { onProgress?: (n: number) => void; signal?: AbortSignal },
    ) => {
      o?.onProgress?.(1);
    },
  );
  return { putPart, putFile, ...over } as Uploader & {
    putPart: typeof putPart;
    putFile: typeof putFile;
  };
}

async function settle(m: UploadManager, pred: (items: readonly UploadItem[]) => boolean) {
  await vi.waitFor(() => expect(pred(m.getSnapshot())).toBe(true), { timeout: 5000 });
}

beforeEach(() => {
  api.calls.length = 0;
  files.fileFromRef
    .mockReset()
    .mockImplementation(
      async (r: { name: string; mime: string; size: number }) =>
        new File([new Uint8Array(Math.min(r.size, 64))], r.name, { type: r.mime }),
    );
  files.deleteNativeCopy.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("UploadManager.addNative", () => {
  it("a single-part photo is streamed from disk with putFile, never read into memory for the PUT, and its copy is released", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    const r = ref();
    m.addNative(BABY, [r]);
    await settle(m, (i) => i.length === 1 && i[0]?.state === "ingested");
    expect(up.putFile).toHaveBeenCalledTimes(1);
    expect(up.putFile.mock.calls[0]?.[0]).toBe("https://s.example.test/p1?sig=1");
    expect(up.putFile.mock.calls[0]?.[1]).toBe(r);
    expect(up.putPart).not.toHaveBeenCalled();
    // the bytes were read once (hash + EXIF) and not again for the PUT
    expect(files.fileFromRef).toHaveBeenCalledTimes(1);
    // done: the app-private copy is deleted
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("registers the file with its size and the client hash", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref({ size: 4321 })]);
    await settle(m, (i) => i[0]?.state === "ingested");
    const reg = api.calls.find((c) => c.path === `/uploads/${SESSION}/files`);
    const sent = (reg?.body as { files?: Record<string, unknown>[] } | undefined)?.files?.[0];
    expect(sent).toMatchObject({ bytes: 4321, clientSha256: "a".repeat(64), mime: "image/jpeg" });
  });

  it("many photos are all queued, hashed one at a time and uploaded", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [ref({ name: "a.jpg" }), ref({ name: "b.jpg" }), ref({ name: "c.jpg" })]);
    await settle(m, (i) => i.length === 3 && i.every((x) => x.state === "ingested"));
    expect(up.putFile).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalled());
  });

  it("a multi-part photo (larger than the part size) falls back to putPart with blob slices", async () => {
    scriptApi({ partSize: 100 });
    const up = fakeUploader();
    files.fileFromRef.mockImplementation(
      async (r: { name: string; mime: string }) =>
        new File([new Uint8Array(250)], r.name, { type: r.mime }),
    );
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [ref({ size: 250 })]);
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(up.putFile).not.toHaveBeenCalled();
    expect(up.putPart).toHaveBeenCalledTimes(3);
    expect(up.putPart.mock.calls.map((c) => (c[1] as Blob).size)).toEqual([100, 100, 50]);
    // bytes read for the hash and again for the foreground PUT
    expect(files.fileFromRef.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to putPart when the uploader has no putFile (web uploader in a native shell)", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => ({ putPart: up.putPart }) });
    m.addNative(BABY, [ref()]);
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(up.putPart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unsupported type", { name: "notes.txt", mime: "text/plain" }],
    ["an empty file", { name: "empty.jpg", size: 0 }],
  ])(
    "%s is shown as failed, never sent to the API, and its copy is deleted at once",
    async (_n, over) => {
      scriptApi();
      const m = new UploadManager({ uploader: () => fakeUploader() });
      const bad = ref(over);
      m.addNative(BABY, [bad]);
      expect(m.getSnapshot().map((i) => [i.state, i.error, i.retryable])).toEqual([
        ["failed", "unsupported", false],
      ]);
      expect(api.calls).toHaveLength(0);
      expect(files.fileFromRef).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(bad));
    },
  );

  it("an oversized file is rejected client-side as too_large", () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref({ size: 1024 * 1024 * 1024 })]);
    expect(m.getSnapshot()[0]).toMatchObject({
      state: "failed",
      error: "too_large",
      retryable: false,
    });
    expect(api.calls).toHaveLength(0);
  });

  it("a working copy that cannot be read fails that photo (not retryable), is never registered and is released", async () => {
    scriptApi();
    files.fileFromRef.mockImplementationOnce(async () => {
      throw new Error("gone");
    });
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    const r = ref({ name: "bad.jpg" });
    m.addNative(BABY, [r]);
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.getSnapshot()[0]).toMatchObject({ error: "unknown", retryable: false });
    expect(api.calls).toHaveLength(0);
    expect(up.putFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("a transport failure is retryable and KEEPS the working copy so Retry can upload again", async () => {
    scriptApi();
    const up = fakeUploader();
    up.putFile.mockImplementation(async () => {
      throw new PartUploadError(403);
    });
    const m = new UploadManager({ uploader: () => up });
    const r = ref();
    m.addNative(BABY, [r]);
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.getSnapshot()[0]).toMatchObject({ error: "network", retryable: true });
    expect(files.deleteNativeCopy).not.toHaveBeenCalled();

    up.putFile.mockImplementation(async () => undefined);
    m.retry(m.getSnapshot()[0]?.clientId as string);
    await settle(m, (i) => i[0]?.state === "ingested");
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("cancelling an in-flight native upload aborts the signal handed to putFile and releases the copy", async () => {
    scriptApi();
    const up = fakeUploader();
    let signal: AbortSignal | undefined;
    up.putFile.mockImplementation(
      (_u: string, _f: unknown, o?: { onProgress?: (n: number) => void; signal?: AbortSignal }) =>
        new Promise<void>((_res, rej) => {
          signal = o?.signal;
          o?.signal?.addEventListener("abort", () =>
            rej(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const m = new UploadManager({ uploader: () => up });
    const r = ref();
    m.addNative(BABY, [r]);
    await vi.waitFor(() => expect(signal).toBeDefined());
    m.cancel(m.getSnapshot()[0]?.clientId as string);
    expect(signal?.aborted).toBe(true);
    expect(m.getSnapshot()[0]?.state).toBe("aborted");
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("a server-side duplicate ends the item as duplicate and still releases the copy", async () => {
    scriptApi();
    api.handler = ((orig) => (path: string, method: string, body: unknown) => {
      if (path === `/uploads/${SESSION}/files` && method === "POST") {
        const reqFiles = (body as { files: { clientId: string }[] }).files;
        return {
          files: reqFiles.map((f, i) => ({
            id: `d${i}`,
            clientId: f.clientId,
            state: "duplicate",
            partSize: PART,
          })),
        };
      }
      return orig(path, method, body);
    })(api.handler);
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    const r = ref();
    m.addNative(BABY, [r]);
    await settle(m, (i) => i[0]?.state === "duplicate");
    expect(up.putFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("never logs paths or presigned URLs", async () => {
    scriptApi();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    const up = fakeUploader();
    up.putFile.mockRejectedValue(new PartUploadError(0));
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [ref()]);
    await settle(m, (i) => i[0]?.state === "failed");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/sig=|ll-uploads/);
  });
});
