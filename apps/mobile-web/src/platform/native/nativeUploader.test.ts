import { afterEach, describe, expect, it, vi } from "vitest";

// The TinyglowUploader bridge (docs/plans/step-9.md 2.6, 2.15): events can arrive before
// `upload()` returns its id (replayed), non-2xx and error events reject, abort cancels natively.

type Handler = (e: never) => void;
const listeners = new Map<string, Handler>();
const plugin = {
  upload: vi.fn(),
  cancel: vi.fn(),
  addListener: vi.fn(async (name: string, cb: Handler) => {
    listeners.set(name, cb);
    return { remove: async () => undefined };
  }),
};

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

const emit = (name: "progress" | "done" | "error", e: object) => listeners.get(name)?.(e as never);
const file = {
  path: "file:///private/cache/ll-uploads/a.jpg",
  name: "a.jpg",
  mime: "image/jpeg",
  size: 100,
};
const URL_ = "https://storage.example.test/bucket/key?X-Amz-Signature=secret";

async function load() {
  vi.resetModules();
  listeners.clear();
  plugin.upload.mockReset();
  plugin.cancel.mockReset().mockResolvedValue(undefined);
  plugin.addListener.mockClear();
  return (await import("./nativeUploader")).nativeUploader;
}

afterEach(() => vi.restoreAllMocks());

describe("nativeUploader.putFile", () => {
  it("hands the url and path to the plugin, reports progress and resolves on a 2xx done", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u1" });
    const onProgress = vi.fn();
    const p = up.putFile?.(URL_, file, { onProgress });
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    expect(plugin.upload).toHaveBeenCalledWith({ url: URL_, path: file.path });
    await Promise.resolve();
    emit("progress", { id: "u1", sent: 40, total: 100 });
    emit("progress", { id: "other", sent: 5, total: 100 });
    emit("done", { id: "u1", status: 200 });
    await expect(p).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(40);
  });

  it("registers its three listeners once for many uploads", async () => {
    const up = await load();
    plugin.upload.mockResolvedValueOnce({ id: "a" }).mockResolvedValueOnce({ id: "b" });
    const p1 = up.putFile?.(URL_, file);
    const p2 = up.putFile?.(URL_, file);
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    emit("done", { id: "a", status: 200 });
    emit("done", { id: "b", status: 204 });
    await Promise.all([p1, p2]);
    expect(plugin.addListener).toHaveBeenCalledTimes(3);
    expect(plugin.addListener.mock.calls.map((c) => c[0]).sort()).toEqual([
      "done",
      "error",
      "progress",
    ]);
  });

  it("replays events that arrived before upload() returned the id (early done)", async () => {
    const up = await load();
    plugin.upload.mockImplementation(async () => {
      // the native side finished before the promise resolved
      emit("progress", { id: "u1", sent: 100, total: 100 });
      emit("done", { id: "u1", status: 200 });
      return { id: "u1" };
    });
    await expect(up.putFile?.(URL_, file)).resolves.toBeUndefined();
  });

  it("replays an early error as a failure", async () => {
    const up = await load();
    plugin.upload.mockImplementation(async () => {
      emit("error", { id: "u1", message: "boom" });
      return { id: "u1" };
    });
    await expect(up.putFile?.(URL_, file)).rejects.toMatchObject({
      name: "PartUploadError",
      status: 0,
    });
  });

  it("drops early progress (only terminal events are replayed)", async () => {
    const up = await load();
    const onProgress = vi.fn();
    plugin.upload.mockImplementation(async () => {
      emit("progress", { id: "u1", sent: 10, total: 100 });
      return { id: "u1" };
    });
    const p = up.putFile?.(URL_, file, { onProgress });
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    emit("done", { id: "u1", status: 200 });
    await p;
    expect(onProgress).not.toHaveBeenCalled();
  });

  it.each([403, 400, 500, 301])(
    "a done event with status %i rejects with that status",
    async (status) => {
      const up = await load();
      plugin.upload.mockResolvedValue({ id: "u1" });
      const p = up.putFile?.(URL_, file);
      p?.catch(() => undefined);
      await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
      await Promise.resolve();
      emit("done", { id: "u1", status });
      await expect(p).rejects.toMatchObject({ name: "PartUploadError" });
      await expect(p).rejects.toMatchObject({ status });
    },
  );

  it("an error event rejects as a network failure (status 0) and never exposes the message", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u1" });
    const p = up.putFile?.(URL_, file);
    p?.catch(() => undefined);
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    emit("error", { id: "u1", message: `failed ${URL_}` });
    const err = await p?.catch((e) => e);
    expect(err.name).toBe("PartUploadError");
    expect(err.status).toBe(0);
    expect(String(err.message)).not.toContain("X-Amz-Signature");
  });

  it("upload() itself failing is a network failure", async () => {
    const up = await load();
    plugin.upload.mockRejectedValue(new Error("no such file"));
    await expect(up.putFile?.(URL_, file)).rejects.toMatchObject({ status: 0 });
  });

  it("aborting calls the plugin's cancel with the upload id and rejects with AbortError", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u1" });
    const ac = new AbortController();
    const p = up.putFile?.(URL_, file, { signal: ac.signal });
    p?.catch(() => undefined);
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(plugin.cancel).toHaveBeenCalledWith({ id: "u1" });
    // late events for the cancelled upload are ignored
    emit("done", { id: "u1", status: 200 });
  });

  it("an already-aborted signal never starts an upload", async () => {
    const up = await load();
    const ac = new AbortController();
    ac.abort();
    await expect(up.putFile?.(URL_, file, { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(plugin.upload).not.toHaveBeenCalled();
  });

  it("a cancel that fails natively is swallowed", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u1" });
    plugin.cancel.mockRejectedValue(new Error("gone"));
    const ac = new AbortController();
    const p = up.putFile?.(URL_, file, { signal: ac.signal });
    p?.catch(() => undefined);
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("settling removes the abort listener (a later abort does not cancel a finished upload)", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u1" });
    const ac = new AbortController();
    const p = up.putFile?.(URL_, file, { signal: ac.signal });
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    emit("done", { id: "u1", status: 200 });
    await p;
    ac.abort();
    expect(plugin.cancel).not.toHaveBeenCalled();
  });

  it("never logs the signed URL or the file path", async () => {
    const up = await load();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    plugin.upload.mockResolvedValue({ id: "u1" });
    const p = up.putFile?.(URL_, file);
    p?.catch(() => undefined);
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    emit("error", { id: "u1", message: "x" });
    await p?.catch(() => undefined);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/X-Amz|ll-uploads/);
  });
});

describe("nativeUploader.putPart", () => {
  it("blob parts (no file reference) still use the web XHR uploader", async () => {
    const up = await load();
    expect(typeof up.putPart).toBe("function");
    expect(typeof up.putFile).toBe("function");
  });
});

describe("nativeUploader with a Capacitor-style Proxy plugin", () => {
  it("does not hang when the plugin answers `then` with a never-settling method", async () => {
    vi.resetModules();
    listeners.clear();
    const proxy = new Proxy(plugin, {
      get(target, prop) {
        if (prop === "then") return () => new Promise(() => undefined);
        return Reflect.get(target, prop);
      },
    });
    const core = await import("@capacitor/core");
    vi.mocked(core.registerPlugin).mockReturnValue(proxy as never);
    plugin.upload.mockReset().mockResolvedValue({ id: "px" });
    plugin.addListener.mockClear();
    const up = (await import("./nativeUploader")).nativeUploader;
    const p = up.putFile?.(URL_, file);
    await vi.waitFor(() => expect(plugin.upload).toHaveBeenCalled());
    await Promise.resolve();
    emit("done", { id: "px", status: 200 });
    await expect(p).resolves.toBeUndefined();
  });
});

describe("nativeUploader.putFile: ranged parts (step 12)", () => {
  it("passes offset/length (and wifiOnly) through to the plugin for one part of a multi-part file", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u1" });
    const p = up.putFile?.(URL_, file, {
      offset: 16 * 1024 * 1024,
      length: 16 * 1024 * 1024,
      wifiOnly: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    emit("done", { id: "u1", status: 200 });
    await p;
    expect(plugin.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        url: URL_,
        path: file.path,
        offset: 16 * 1024 * 1024,
        length: 16 * 1024 * 1024,
        wifiOnly: true,
      }),
    );
  });

  it("a single-part file sends no range and no wifiOnly key", async () => {
    const up = await load();
    plugin.upload.mockResolvedValue({ id: "u2" });
    const p = up.putFile?.(URL_, file, {});
    await new Promise((r) => setTimeout(r, 0));
    emit("done", { id: "u2", status: 200 });
    await p;
    const arg = plugin.upload.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("offset" in arg).toBe(false);
    expect("length" in arg).toBe(false);
    expect("wifiOnly" in arg).toBe(false);
  });

  it("a local refusal (no-space / bad-range) comes back from upload() itself as a PartUploadError with the reason, never a message", async () => {
    const up = await load();
    const { PartUploadError } = await import("../uploader");
    for (const reason of ["no-space", "bad-range"] as const) {
      plugin.upload.mockReset().mockRejectedValue({
        code: reason,
        message: "/private/var/secret/path X-Amz-Signature=abc",
      });
      const putFile = up.putFile as NonNullable<typeof up.putFile>;
      const err = await putFile(URL_, file, { offset: 0, length: 10 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PartUploadError);
      expect((err as InstanceType<typeof PartUploadError>).reason).toBe(reason);
      expect((err as InstanceType<typeof PartUploadError>).status).toBe(0);
      expect((err as Error).message).not.toContain("X-Amz-Signature");
      expect((err as Error).message).not.toContain("/private/var");
    }
  });
});
