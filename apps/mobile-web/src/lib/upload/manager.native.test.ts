import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartUploadError, type Uploader } from "../../platform/uploader";
import { ApiError } from "../api";
import { type UploadItem, UploadManager } from "./manager";

// UploadManager with native file references (docs/plans/step-9.md 2.6, 2.15): single-part files
// go to the background uploader straight from disk (`putFile`), multi-part files are one ranged
// `putFile` per part (step 12), rejected files never reach the API, working copies are released.

// The manager imports this module lazily, once per released copy, without awaiting. The test
// runner only applies the mock to the FIRST of several such overlapping imports, so tests that
// assert on releases use one copy at a time (or assert "at least one").
const files = vi.hoisted(() => ({
  fileFromRef: vi.fn(),
  deleteNativeCopy: vi.fn(),
  // Native videos are never read into the WebView: the duration comes from the ref or from a
  // metadata-only <video> on the file URL (undefined here: no browser demuxer in jsdom).
  nativeVideoDuration: vi.fn(async (): Promise<number | undefined> => undefined),
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

  it("a multi-part file (larger than the part size) goes through putFile once per part with a byte range", async () => {
    scriptApi({ partSize: 100 });
    const up = fakeUploader();
    files.fileFromRef.mockImplementation(
      async (r: { name: string; mime: string }) =>
        new File([new Uint8Array(250)], r.name, { type: r.mime }),
    );
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [ref({ size: 250 })]);
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(up.putPart).not.toHaveBeenCalled();
    expect(up.putFile).toHaveBeenCalledTimes(3);
    expect(
      up.putFile.mock.calls.map((c) => {
        const o = c[2] as { offset?: number; length?: number };
        return [o.offset, o.length];
      }),
    ).toEqual([
      [0, 100],
      [100, 100],
      [200, 50],
    ]);
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

// ---- step 12 leftovers (docs/plans/step-12.md 2.5, Q6): native uploader refusals and the
// persisted cellular preference ------------------------------------------------------------------

describe("UploadManager.addNative: local refusals and the large-video Wi-Fi default", () => {
  it("a `bad-range` on the first part of a multi-part video fails the whole item promptly (no part retries)", async () => {
    scriptApi();
    const up = fakeUploader();
    up.putFile.mockImplementation(async () => {
      throw new PartUploadError(0, "bad-range");
    });
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [ref({ size: 40 * 1024 * 1024, mime: "video/mp4", name: "clip.mp4" })]);
    await vi.waitFor(() => expect(m.getSnapshot()[0]?.state).toBe("failed"), { timeout: 20_000 });
    expect(m.getSnapshot()[0]).toMatchObject({ error: "bad_range", retryable: false });
    expect(up.putFile).toHaveBeenCalledTimes(1);
  }, 25_000);

  it("a `no-space` refusal from the uploader fails the item as no_space, NOT retryable, and releases the copy", async () => {
    scriptApi();
    const up = fakeUploader();
    up.putFile.mockImplementation(async () => {
      throw new PartUploadError(0, "no-space");
    });
    const m = new UploadManager({ uploader: () => up });
    const r = ref();
    m.addNative(BABY, [r]);
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.getSnapshot()[0]).toMatchObject({ error: "no_space", retryable: false });
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("a `bad-range` refusal (file changed under us) fails the item as bad_range, not retryable", async () => {
    scriptApi();
    const up = fakeUploader();
    up.putFile.mockImplementation(async () => {
      throw new PartUploadError(0, "bad-range");
    });
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [ref({ name: "range.jpg" })]);
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.getSnapshot()[0]).toMatchObject({ error: "bad_range", retryable: false });
    // the refusal is final: putFile was tried once, never retried with a backoff
    expect(up.putFile).toHaveBeenCalledTimes(1);
    // Retry is a no-op for a non-retryable failure
    const id = m.getSnapshot()[0]?.clientId as string;
    m.retry(id);
    expect(m.getSnapshot()[0]?.state).toBe("failed");
  });

  it("a large video defaults to Wi-Fi only, unless the Settings preference allows cellular or the item says otherwise", async () => {
    const { setCellularForLargeVideos } = await import("./prefs");
    scriptApi();
    const big = ref({ size: 60 * 1024 * 1024, mime: "video/mp4", name: "big.mp4" });
    const small = ref({ size: 1_000_000, name: "small.jpg" });

    const m1 = new UploadManager({ uploader: () => fakeUploader() });
    m1.addNative(BABY, [big, small]);
    expect(m1.getSnapshot().map((i) => i.wifiOnly)).toEqual([true, false]);

    setCellularForLargeVideos(true);
    const m2 = new UploadManager({ uploader: () => fakeUploader() });
    m2.addNative(BABY, [big]);
    expect(m2.getSnapshot()[0]?.wifiOnly).toBe(false);

    setCellularForLargeVideos(false);
    const m3 = new UploadManager({ uploader: () => fakeUploader() });
    m3.addNative(BABY, [big], undefined, { wifiOnly: false });
    expect(m3.getSnapshot()[0]?.wifiOnly).toBe(false);
    const m4 = new UploadManager({ uploader: () => fakeUploader() });
    m4.addNative(BABY, [small], undefined, { wifiOnly: true });
    expect(m4.getSnapshot()[0]?.wifiOnly).toBe(true);
  });
});

describe("UploadManager.addNative: native videos are never read into the WebView (iOS fix)", () => {
  /** The register body for `m`'s first item (a previous test's manager may still be registering). */
  const regBody = (m: UploadManager) => {
    const clientId = m.getSnapshot()[0]?.clientId;
    for (const c of api.calls) {
      if (c.path !== `/uploads/${SESSION}/files`) continue;
      const f = (c.body as { files?: Record<string, unknown>[] }).files?.find(
        (x) => x.clientId === clientId,
      );
      if (f) return f;
    }
    return undefined;
  };
  const clip = (over: Partial<{ durationMs: number; mime: string; size: number }> = {}) => ({
    ...ref({
      path: "file:///cache/ll-uploads/x.mov",
      name: "clip.mov",
      mime: "video/quicktime",
      size: 5_000_000,
    }),
    ...over,
  });

  beforeEach(() => {
    files.nativeVideoDuration.mockReset().mockResolvedValue(undefined);
  });

  it("(1) a video ref with a picker duration: fileFromRef is never called; registered as kind video with durationMs and the ref's size, no clientSha256", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    const r = clip({ durationMs: 12_000 });
    m.addNative(BABY, [r], undefined, { plan: "plus" });
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(files.fileFromRef).not.toHaveBeenCalled();
    expect(files.nativeVideoDuration).not.toHaveBeenCalled();
    const sent = regBody(m);
    expect(sent).toMatchObject({ kind: "video", durationMs: 12_000, bytes: 5_000_000 });
    expect(sent).not.toHaveProperty("clientSha256");
    expect(m.getSnapshot()[0]).toMatchObject({ kind: "video", durationMs: 12_000 });
    expect(up.putFile.mock.calls[0]?.[1]).toBe(r);
  });

  it("(2) without a picker duration the metadata-only reader runs once; its result lands in the item and the register body; undefined registers without durationMs", async () => {
    scriptApi();
    files.nativeVideoDuration.mockResolvedValueOnce(7_250);
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const r = clip();
    m.addNative(BABY, [r], undefined, { plan: "plus" });
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(files.nativeVideoDuration).toHaveBeenCalledTimes(1);
    expect(files.nativeVideoDuration).toHaveBeenCalledWith(r);
    expect(files.fileFromRef).not.toHaveBeenCalled();
    expect(m.getSnapshot()[0]).toMatchObject({ durationMs: 7_250 });
    expect(regBody(m)).toMatchObject({ kind: "video", durationMs: 7_250 });

    const m2 = new UploadManager({ uploader: () => fakeUploader() });
    m2.addNative(BABY, [clip({ size: 4_000_000 })], undefined, { plan: "plus" });
    await settle(m2, (i) => i[0]?.state === "ingested");
    expect(files.nativeVideoDuration).toHaveBeenCalledTimes(2);
    const sent = regBody(m2);
    expect(sent).toMatchObject({ kind: "video", bytes: 4_000_000 });
    expect(sent).not.toHaveProperty("durationMs");
    expect(sent).not.toHaveProperty("clientSha256");
    expect(m2.getSnapshot()[0]).not.toHaveProperty("durationMs");
  });

  it("(3) a rejecting duration reader still registers the clip (the worker's ffprobe is the truth)", async () => {
    scriptApi();
    files.nativeVideoDuration.mockRejectedValueOnce(new Error("no demuxer file:///cache/x.mov"));
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [clip()], undefined, { plan: "free" });
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(regBody(m)).toMatchObject({ kind: "video" });
    expect(regBody(m)).not.toHaveProperty("durationMs");
    expect(up.putFile).toHaveBeenCalledTimes(1);
  });

  it("(4) a free-plan video ref of 61 s fails video_too_long before any API call and releases the copy", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    const r = clip({ durationMs: 61_000 });
    m.addNative(BABY, [r], undefined, { plan: "free" });
    expect(m.getSnapshot()[0]).toMatchObject({
      state: "failed",
      error: "video_too_long",
      retryable: false,
      kind: "video",
    });
    expect(regBody(m)).toBeUndefined();
    expect(up.putFile).not.toHaveBeenCalled();
    expect(files.fileFromRef).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("(4b) the same 61 s learnt from the metadata reader fails video_too_long after queueing, still with no API call", async () => {
    scriptApi();
    files.nativeVideoDuration.mockResolvedValueOnce(61_000);
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const r = clip();
    m.addNative(BABY, [r], undefined, { plan: "free" });
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.getSnapshot()[0]).toMatchObject({ error: "video_too_long", durationMs: 61_000 });
    expect(regBody(m)).toBeUndefined();
    await vi.waitFor(() => expect(files.deleteNativeCopy).toHaveBeenCalledWith(r));
  });

  it("(5) a photo ref still goes through fileFromRef (hash + EXIF) and registers with a clientSha256", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref({ size: 2222 })]);
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(files.fileFromRef).toHaveBeenCalledTimes(1);
    expect(files.nativeVideoDuration).not.toHaveBeenCalled();
    expect(regBody(m)).toMatchObject({ kind: "photo", bytes: 2222, clientSha256: "a".repeat(64) });
  });
});
