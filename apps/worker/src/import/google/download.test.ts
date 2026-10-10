import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./client";
import {
  type AccessTokenSource,
  DownloadError,
  downloadMedia,
  importTmpDir,
  removeStaged,
  SNIFF_HEAD_BYTES,
  stagedPath,
} from "./download";

// Download guard (docs/plans/step-10.md 2.7, D6): allow-listed hosts only, redirects re-checked,
// size cap, SHA-256 while streaming, temp file removed on every failure, errors carry categories.

const allowList = {
  hostSuffixes: ["googleusercontent.com"] as const,
  exactOrigins: ["http://google-fake:8099"] as const,
};
const BASE = "https://lh3.googleusercontent.com/pw/AP1Gcz";
const FAKE_BASE = "http://google-fake:8099/media/G-1";
const body = Buffer.from("not really a jpeg but fine ".repeat(50));
const tokenSource = (
  t = "fake-access-1",
): AccessTokenSource & { refresh: ReturnType<typeof vi.fn> } => ({
  get: async () => t,
  refresh: vi.fn(async () => "fake-access-2"),
});
const ok = (b: Buffer, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(b), {
    status: 200,
    headers: { "content-length": String(b.length), ...headers },
  });

describe("downloadMedia", () => {
  let tmp: string;
  const itemId = randomUUID();
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ll-dl-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const run = (
    f: FetchLike,
    over: Partial<Parameters<typeof downloadMedia>[0]> = {},
    t = tokenSource(),
    base = BASE,
  ) =>
    downloadMedia(
      {
        allowList,
        maxBytes: 10_000,
        tmpDir: tmp,
        fetchImpl: f,
        sleep: async () => undefined,
        attempts: 3,
        ...over,
      },
      t,
      itemId,
      base,
    );
  const staged = async () => (await readdir(tmp)).filter((n) => !n.startsWith("."));

  it("streams to the staging file, hashing and keeping the head; requests baseUrl=d with a bearer", async () => {
    const f = vi.fn<FetchLike>(async () => ok(body));
    const r = await run(f);
    expect(r.bytes).toBe(body.length);
    expect(r.sha256.equals(createHash("sha256").update(body).digest())).toBe(true);
    expect(r.head.equals(body.subarray(0, SNIFF_HEAD_BYTES))).toBe(true);
    expect(r.path).toBe(path.join(tmp, itemId));
    expect((await readFile(r.path)).equals(body)).toBe(true);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}=d`);
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer fake-access-1",
    );
    expect(init?.redirect).toBe("manual");
  });

  it("accepts the dev fake's exact origin", async () => {
    const f = vi.fn<FetchLike>(async () => ok(body));
    await run(f, {}, tokenSource(), FAKE_BASE);
    expect(f.mock.calls[0]?.[0]).toBe(`${FAKE_BASE}=d`);
  });

  it.each([
    ["an evil host", "https://evil.test/x"],
    ["metadata service", "http://169.254.169.254/latest"],
    ["http googleusercontent", "http://lh3.googleusercontent.com/x"],
    ["user-info", "https://u:p@lh3.googleusercontent.com/x"],
    ["a lookalike", "https://evil-googleusercontent.com/x"],
    ["an IP literal", "https://127.0.0.1/x"],
    ["another port on the fake host", "http://google-fake:9999/media/G-1"],
  ])("never fetches %s", async (_n, url) => {
    const f = vi.fn<FetchLike>(async () => ok(body));
    await expect(run(f, {}, tokenSource(), url)).rejects.toMatchObject({
      category: "disallowed_url",
    });
    expect(f).not.toHaveBeenCalled();
    expect(await staged()).toEqual([]);
  });

  it("follows a same-host redirect", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://lh3.googleusercontent.com/other" },
        }),
      )
      .mockResolvedValueOnce(ok(body));
    const r = await run(f);
    expect(r.bytes).toBe(body.length);
    expect(f.mock.calls[1]?.[0]).toBe("https://lh3.googleusercontent.com/other");
  });

  it.each([
    ["another allow-listed host", "https://lh4.googleusercontent.com/other"],
    ["an evil host", "https://evil.test/x"],
    ["the metadata service", "http://169.254.169.254/"],
    ["a downgrade to http", "http://lh3.googleusercontent.com/x"],
  ])("refuses a redirect to %s and does not follow it", async (_n, location) => {
    const f = vi.fn<FetchLike>(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(run(f)).rejects.toMatchObject({ category: "disallowed_url" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(await staged()).toEqual([]);
  });

  it("gives up after two redirect hops", async () => {
    const f = vi.fn<FetchLike>(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    );
    await expect(run(f)).rejects.toMatchObject({ category: "too_many_redirects" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("aborts on a Content-Length above the cap without reading the body", async () => {
    const cancel = vi.fn();
    const f = vi.fn<FetchLike>(async () => {
      const res = new Response(new ReadableStream({ cancel, start() {} }), {
        status: 200,
        headers: { "content-length": String(200 * 1024 * 1024) },
      });
      return res;
    });
    await expect(run(f)).rejects.toMatchObject({ category: "file_too_large" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(await staged()).toEqual([]);
  });

  it("aborts mid-stream when the counted bytes pass the cap (no Content-Length), removing the partial file", async () => {
    const big = Buffer.alloc(30_000, 7);
    const f = vi.fn<FetchLike>(async () => new Response(new Uint8Array(big), { status: 200 }));
    await expect(run(f)).rejects.toMatchObject({ category: "file_too_large" });
    expect(await staged()).toEqual([]);
  });

  it("a truncated body (fewer bytes than Content-Length) is retried, then network; nothing is left", async () => {
    const f = vi.fn<FetchLike>(
      async () =>
        new Response(new Uint8Array(body.subarray(0, 100)), {
          status: 200,
          headers: { "content-length": String(body.length) },
        }),
    );
    await expect(run(f)).rejects.toMatchObject({ category: "network" });
    expect(f).toHaveBeenCalledTimes(3);
    expect(await staged()).toEqual([]);
  });

  it("an empty body is a network failure", async () => {
    const f = vi.fn<FetchLike>(async () => new Response(new Uint8Array(0), { status: 200 }));
    await expect(run(f, { attempts: 1 })).rejects.toMatchObject({ category: "network" });
    expect(await staged()).toEqual([]);
  });

  it("retries 503 then succeeds (honouring Retry-After)", async () => {
    const sleep = vi.fn(async () => undefined);
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(ok(body));
    const r = await run(f, { sleep });
    expect(r.bytes).toBe(body.length);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("a 404 is not retried", async () => {
    const f = vi.fn<FetchLike>(async () => new Response(null, { status: 404 }));
    await expect(run(f)).rejects.toMatchObject({ category: "http", status: 404 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 401 asks for one fresh token and retries with it; a second 401 is unauthorized", async () => {
    const t = tokenSource();
    let tok = "fake-access-1";
    t.get = async () => tok;
    t.refresh = vi.fn(async () => {
      tok = "fake-access-2";
      return tok;
    });
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(ok(body));
    await run(f, {}, t);
    expect(
      (f.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined)?.authorization,
    ).toBe("Bearer fake-access-2");
    expect(t.refresh).toHaveBeenCalledTimes(1);

    const t2 = tokenSource();
    const f2 = vi.fn<FetchLike>(async () => new Response(null, { status: 401 }));
    await expect(run(f2, {}, t2)).rejects.toMatchObject({ category: "unauthorized" });
    expect(t2.refresh).toHaveBeenCalledTimes(1);
  });

  it("connection errors are retried then network, with no URL or token in the error", async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new Error(`boom ${BASE} fake-access-1`);
    });
    const err = await run(f).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.category).toBe("network");
    expect(JSON.stringify([err.message, err.category, err.status])).not.toMatch(
      /googleusercontent|fake-access/,
    );
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("an idle stall aborts as network", async () => {
    const f = vi.fn<FetchLike>(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(run(f, { idleTimeoutMs: 20, attempts: 1 })).rejects.toMatchObject({
      category: "network",
    });
  });

  it("stagedPath only takes uuids (no traversal) and removeStaged never throws", async () => {
    expect(() => stagedPath(tmp, "../etc/passwd")).toThrow(DownloadError);
    expect(stagedPath(tmp, itemId)).toBe(path.join(tmp, itemId));
    await expect(removeStaged(path.join(tmp, "missing"))).resolves.toBeUndefined();
    expect(importTmpDir("/x")).toBe("/x/ll-import");
  });
});
