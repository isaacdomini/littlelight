import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartUploadError, type Uploader } from "../../platform/uploader";
import { ApiError } from "../api";
import { readCaptureHint } from "./exif";
import { sha256Hex } from "./hash";
import { summarize, type UploadItem, UploadManager } from "./manager";

// UploadManager sync lane (docs/plans/step-10.md 2.5): items added with { lane: "sync" } skip our own
// hashing, upload at most SYNC_LANE_CONCURRENCY at once without delaying user items, pass wifiOnly to
// the native uploader, are never retried in place and never have their files deleted by the manager.

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

const HEX = "ab".repeat(32);
const syncRef = (n: number, over: Record<string, unknown> = {}) => ({
  path: `file:///cache/ll-sync/s${n}.heic`,
  name: `S${n}.heic`,
  mime: "image/heic",
  size: 2_000_000,
  sha256: HEX.replace(/^../, n.toString(16).padStart(2, "0")),
  takenAt: "2026-03-01T10:00:00Z",
  ...over,
});

/** A putFile that blocks until released, recording how many ran at once. */
function gatedUploader() {
  const gates: (() => void)[] = [];
  const st = { running: 0, max: 0, order: [] as string[] };
  const putFile = vi.fn(async (_u: string, f: { name: string }, o?: { wifiOnly?: boolean }) => {
    st.running++;
    st.max = Math.max(st.max, st.running);
    st.order.push(f.name);
    await new Promise<void>((r) => gates.push(r));
    st.running--;
    void o;
  });
  return {
    up: { putPart: vi.fn(), putFile } as unknown as Uploader & { putFile: typeof putFile },
    gates,
    st,
    putFile,
  };
}

describe("addNative lanes", () => {
  it("returns one client id per file, in order, and tags the lane (default user)", () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const ids = m.addNative(BABY, [ref({ name: "a.jpg" }), ref({ name: "b.jpg" })]);
    expect(ids).toHaveLength(2);
    expect(m.getSnapshot().map((i) => i.clientId)).toEqual(ids);
    expect(m.getSnapshot().every((i) => i.lane === "user")).toBe(true);
    const syncIds = m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    expect(syncIds).toHaveLength(1);
    expect(m.getSnapshot().find((i) => i.clientId === syncIds[0])?.lane).toBe("sync");
  });

  it("rejected files still get an id (and appear as failed)", () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const ids = m.addNative(BABY, [ref({ name: "x.txt", mime: "text/plain" })], undefined, {
      lane: "sync",
    });
    expect(ids).toHaveLength(1);
    expect(m.getSnapshot()[0]).toMatchObject({
      state: "failed",
      error: "unsupported",
      lane: "sync",
    });
    expect(m.errorOf(ids[0] as string)).toBe("unsupported");
  });

  it("a precomputed sha256 skips the manager's own hashing and EXIF read, and is sent with the capture hint", async () => {
    scriptApi();
    vi.mocked(sha256Hex).mockClear();
    vi.mocked(readCaptureHint).mockClear();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    const [id] = m.addNative(BABY, [syncRef(7)], undefined, { lane: "sync" });
    await settle(m, (i) => i.find((x) => x.clientId === id)?.state === "ingested");
    expect(sha256Hex).not.toHaveBeenCalled();
    expect(readCaptureHint).not.toHaveBeenCalled();
    expect(files.fileFromRef).not.toHaveBeenCalled();
    const sent = api.calls
      .filter((c) => c.path === `/uploads/${SESSION}/files`)
      .flatMap((c) => (c.body as { files: Record<string, unknown>[] }).files)
      .find((f) => f.clientId === id);
    expect(sent).toMatchObject({
      clientSha256: syncRef(7).sha256,
      mime: "image/heic",
      bytes: 2_000_000,
    });
    expect(sent).toMatchObject({ takenAt: "2026-03-01T10:00:00Z" });
  });

  it("without a precomputed hash the manager hashes as before", async () => {
    scriptApi();
    vi.mocked(sha256Hex).mockClear();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref()]);
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(sha256Hex).toHaveBeenCalledTimes(1);
  });

  it("a precomputed hash on a rejected file is ignored (nothing reaches the API)", () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [syncRef(1, { mime: "application/pdf", name: "x.pdf" })], undefined, {
      lane: "sync",
    });
    expect(m.getSnapshot()[0]?.state).toBe("failed");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wifiOnly", () => {
  it("reaches the native uploader for a sync item that asks for it", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync", wifiOnly: true });
    await settle(m, (i) => i[0]?.state === "ingested");
    expect(up.putFile.mock.calls[0]?.[2]).toMatchObject({ wifiOnly: true });
  });

  it("is absent for a sync item without it and for user items", async () => {
    scriptApi();
    const up = fakeUploader();
    const m = new UploadManager({ uploader: () => up });
    m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync", wifiOnly: false });
    m.addNative(BABY, [ref()]);
    await settle(m, (i) => i.length === 2 && i.every((x) => x.state === "ingested"));
    for (const c of up.putFile.mock.calls)
      expect((c[2] as { wifiOnly?: boolean }).wifiOnly).toBeUndefined();
  });
});

describe("lane scheduling", () => {
  it("never runs more than two sync uploads at once", async () => {
    scriptApi();
    const g = gatedUploader();
    const m = new UploadManager({ uploader: () => g.up });
    m.addNative(
      BABY,
      [1, 2, 3, 4, 5].map((n) => syncRef(n)),
      undefined,
      { lane: "sync" },
    );
    await vi.waitFor(() => expect(g.st.running).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(g.st.running).toBe(2);
    expect(g.st.max).toBe(2);
    while (g.gates.length > 0 || g.st.order.length < 5) {
      g.gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await settle(m, (i) => i.every((x) => x.state === "ingested"));
    expect(g.st.max).toBe(2);
  });

  it("a user item starts at once even while the sync lane is saturated", async () => {
    scriptApi();
    const g = gatedUploader();
    const m = new UploadManager({ uploader: () => g.up });
    m.addNative(
      BABY,
      [1, 2, 3].map((n) => syncRef(n)),
      undefined,
      { lane: "sync" },
    );
    await vi.waitFor(() => expect(g.st.running).toBe(2));
    m.addNative(BABY, [ref({ name: "mine.jpg" })]);
    await vi.waitFor(() => expect(g.st.order).toContain("mine.jpg"));
    expect(g.st.running).toBe(3);
    for (let i = 0; i < 40; i++) {
      g.gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  it("user items are dequeued before waiting sync items", async () => {
    scriptApi();
    const g = gatedUploader();
    const m = new UploadManager({ uploader: () => g.up });
    // Fill all four upload slots with user items so the next arrivals queue.
    m.addNative(
      BABY,
      [1, 2, 3, 4].map((n) => ref({ name: `u${n}.jpg` })),
    );
    await vi.waitFor(() => expect(g.st.running).toBe(4));
    m.addNative(BABY, [syncRef(1), syncRef(2)], undefined, { lane: "sync" });
    m.addNative(BABY, [ref({ name: "later-user.jpg" })]);
    await new Promise((r) => setTimeout(r, 60)); // let both lanes queue behind the full slots
    g.gates.shift()?.(); // free one slot
    await vi.waitFor(() => expect(g.st.order).toContain("later-user.jpg"));
    expect(g.st.order.indexOf("later-user.jpg")).toBeLessThan(
      g.st.order.indexOf("S1.heic") === -1 ? 99 : g.st.order.indexOf("S1.heic"),
    );
    for (let i = 0; i < 60; i++) {
      g.gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
  });
});

describe("sync items on failure and completion", () => {
  it("a transport failure is not retryable in place (the ledger and the next run decide)", async () => {
    scriptApi();
    const up = fakeUploader();
    up.putFile.mockImplementation(async () => {
      throw new PartUploadError(403);
    });
    const m = new UploadManager({ uploader: () => up });
    const [id] = m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.getSnapshot()[0]).toMatchObject({ error: "network", retryable: false });
    expect(m.errorOf(id as string)).toBe("network");
  });

  it("free_tier_limit surfaces as the error code the sync run looks for", async () => {
    scriptApi();
    api.handler = (path, method, body) => {
      if (path === `/uploads/${SESSION}/files` && method === "POST") {
        const f = (body as { files: { clientId: string }[] }).files;
        return {
          files: f.map((x) => ({
            id: "f0",
            clientId: x.clientId,
            state: "failed",
            error: "free_tier_limit",
            partSize: PART,
            parts: [],
          })),
        };
      }
      if (path === `/babies/${BABY}/uploads`) return { id: SESSION };
      return undefined;
    };
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const [id] = m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    await settle(m, (i) => i[0]?.state === "failed");
    expect(m.errorOf(id as string)).toBe("free_tier_limit");
  });

  it("the manager never deletes the exported file of a sync item (the sync manager discards them natively)", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [syncRef(1), syncRef(2, { mime: "text/plain", name: "no.txt" })], undefined, {
      lane: "sync",
    });
    await settle(m, (i) => i.every((x) => x.state === "ingested" || x.state === "failed"));
    await new Promise((r) => setTimeout(r, 30));
    expect(files.deleteNativeCopy).not.toHaveBeenCalled();
  });
});

describe("waitForTerminal / errorOf / clearFinished / summarize", () => {
  it("resolves once every listed item has settled, with their states", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const ids = m.addNative(BABY, [syncRef(1), syncRef(2)], undefined, { lane: "sync" });
    const states = await m.waitForTerminal(ids);
    expect([...states.keys()]).toEqual(ids);
    for (const s of states.values()) expect(["ingested", "completed"]).toContain(s);
  });

  it("an empty list resolves at once", async () => {
    const m = new UploadManager({ uploader: () => fakeUploader() });
    expect((await m.waitForTerminal([])).size).toBe(0);
  });

  it("an abort resolves early with the states reached so far", async () => {
    scriptApi();
    const g = gatedUploader();
    const m = new UploadManager({ uploader: () => g.up });
    const ids = m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    const ac = new AbortController();
    const p = m.waitForTerminal(ids, ac.signal);
    await vi.waitFor(() => expect(g.st.running).toBe(1));
    ac.abort();
    const states = await p;
    expect(states.get(ids[0] as string)).not.toBe("ingested");
    g.gates.shift()?.();
  });

  it("an already aborted signal resolves immediately; an unknown id reads as aborted", async () => {
    const m = new UploadManager({ uploader: () => fakeUploader() });
    const ac = new AbortController();
    ac.abort();
    const states = await m.waitForTerminal(["nope"], ac.signal);
    expect(states.get("nope")).toBe("aborted");
  });

  it("errorOf is null for unknown ids", () => {
    const m = new UploadManager({ uploader: () => fakeUploader() });
    expect(m.errorOf("nope")).toBeNull();
  });

  it("clearFinished(baby, lane) removes only that lane's finished rows", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref()]);
    m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    await settle(m, (i) => i.length === 2 && i.every((x) => x.state === "ingested"));
    m.clearFinished(BABY, "sync");
    expect(m.getSnapshot().map((i) => i.lane)).toEqual(["user"]);
    m.clearFinished(BABY);
    expect(m.getSnapshot()).toEqual([]);
  });

  it("the default clearFinished leaves sync rows alone", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref()]);
    m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    await settle(m, (i) => i.length === 2 && i.every((x) => x.state === "ingested"));
    m.clearFinished(BABY);
    expect(m.getSnapshot().map((i) => i.lane)).toEqual(["sync"]);
  });

  it("summarize can be limited to a lane", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [ref(), ref({ name: "b.jpg" })]);
    m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    await settle(m, (i) => i.length === 3 && i.every((x) => x.state === "ingested"));
    expect(summarize(m.getSnapshot()).total).toBe(3);
    expect(summarize(m.getSnapshot(), "user")).toMatchObject({ total: 2, uploaded: 2 });
    expect(summarize(m.getSnapshot(), "sync")).toMatchObject({ total: 1, uploaded: 1 });
  });

  it("a sync item is not part of the user's resume record", async () => {
    scriptApi();
    const m = new UploadManager({ uploader: () => fakeUploader() });
    m.addNative(BABY, [syncRef(1)], undefined, { lane: "sync" });
    await settle(m, (i) => i[0]?.state === "ingested");
    const stored = Object.keys(window.localStorage).filter((k) => k.startsWith("ll.upload"));
    for (const k of stored) expect(window.localStorage.getItem(k)).not.toContain(syncRef(1).sha256);
  });
});
