import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { fakeUpstream, jsonRes, testManifest } from "../testing/app-update";
import {
  APP_UPDATE_SOURCE_MAX_BYTES,
  APP_UPDATE_SOURCE_RETRY_MS,
  APP_UPDATE_SOURCE_STALE_MS,
  APP_UPDATE_SOURCE_TTL_MS,
  createManifestSource,
} from "./source";

// Manifest upstream cache (docs/plans/step-14.md 2.6).

const URL_ = "http://web.internal.test/app-update/manifest.json";

function captureLog() {
  const lines: { level: string; obj: unknown; msg?: string }[] = [];
  const mk =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, obj, msg });
    };
  const log = {
    level: "info",
    info: mk("info"),
    warn: mk("warn"),
    error: mk("error"),
    debug: mk("debug"),
    trace: mk("trace"),
    fatal: mk("fatal"),
    silent: () => undefined,
    child: () => log,
  } as unknown as FastifyBaseLogger;
  return { log, lines };
}

function setup(first: () => Response | Promise<Response>, extra: { timeoutMs?: number } = {}) {
  let t = 1_000_000;
  const up = fakeUpstream(first);
  const { log, lines } = captureLog();
  const source = createManifestSource({
    url: URL_,
    log,
    fetch: up.fetch,
    now: () => t,
    ...extra,
  });
  return {
    source,
    up,
    lines,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const A = testManifest({ "index.html": "<html>A</html>" });
const B = testManifest({ "index.html": "<html>B</html>" });

describe("createManifestSource", () => {
  it("caches a good manifest for 60 s, then revalidates with If-None-Match; 304 keeps it", async () => {
    const s = setup(() => jsonRes(A, 200, { etag: '"a1"' }));
    expect((await s.source.get())?.version).toBe(A.version);
    s.advance(APP_UPDATE_SOURCE_TTL_MS - 1);
    expect((await s.source.get())?.version).toBe(A.version);
    expect(s.up.calls).toHaveLength(1);
    expect(s.up.calls[0]?.headers["if-none-match"]).toBeUndefined();
    s.advance(2);
    s.up.respond(() => new Response(null, { status: 304 }));
    const again = await s.source.get();
    expect(again?.version).toBe(A.version);
    expect(s.up.calls).toHaveLength(2);
    expect(s.up.calls[1]?.headers["if-none-match"]).toBe('"a1"');
    // 304 renews freshness
    s.advance(APP_UPDATE_SOURCE_TTL_MS - 1);
    await s.source.get();
    expect(s.up.calls).toHaveLength(2);
  });

  it("keeps the same object for an unchanged manifest (envelope memo) and switches on a new one", async () => {
    const s = setup(() => jsonRes(A));
    const first = await s.source.get();
    s.advance(APP_UPDATE_SOURCE_TTL_MS);
    expect(await s.source.get()).toBe(first);
    s.up.respond(() => jsonRes(B));
    s.advance(APP_UPDATE_SOURCE_TTL_MS);
    expect((await s.source.get())?.version).toBe(B.version);
  });

  it("serves stale up to 24 h on transport errors (network, 5xx), never after", async () => {
    const s = setup(() => jsonRes(A));
    await s.source.get();
    s.advance(APP_UPDATE_SOURCE_TTL_MS);
    s.up.respond(() => {
      throw new TypeError("fetch failed");
    });
    expect((await s.source.get())?.version).toBe(A.version);
    s.advance(APP_UPDATE_SOURCE_RETRY_MS);
    s.up.respond(() => jsonRes("oops", 503));
    expect((await s.source.get())?.version).toBe(A.version);
    s.advance(APP_UPDATE_SOURCE_STALE_MS);
    expect(await s.source.get()).toBeNull();
  });

  it.each([
    ["404", () => jsonRes("not found", 404)],
    ["403", () => jsonRes("no", 403)],
    ["an html page (Vite dev)", () => new Response("<!doctype html>", { status: 200 })],
    ["an invalid manifest", () => jsonRes({ ...A, files: [] })],
    [
      "a manifest with an excluded path",
      () =>
        jsonRes({
          ...A,
          files: [...A.files, { path: ".well-known/x", sha256: "0".repeat(64), size: 0 }],
        }),
    ],
  ])("%s drops the cached manifest at once", async (_n, bad) => {
    const s = setup(() => jsonRes(A));
    await s.source.get();
    s.advance(APP_UPDATE_SOURCE_TTL_MS);
    s.up.respond(bad);
    expect(await s.source.get()).toBeNull();
  });

  it("a 304 without a cached manifest is unavailable", async () => {
    const s = setup(() => new Response(null, { status: 304 }));
    expect(await s.source.get()).toBeNull();
  });

  it("backs off 10 s after a failure, then retries and recovers", async () => {
    const s = setup(() => jsonRes("x", 500));
    expect(await s.source.get()).toBeNull();
    s.advance(APP_UPDATE_SOURCE_RETRY_MS - 1);
    expect(await s.source.get()).toBeNull();
    expect(s.up.calls).toHaveLength(1);
    s.up.respond(() => jsonRes(A));
    s.advance(1);
    expect((await s.source.get())?.version).toBe(A.version);
    expect(s.up.calls).toHaveLength(2);
  });

  it("concurrent callers share one fetch (single-flight)", async () => {
    let release: (r: Response) => void = () => undefined;
    const s = setup(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const all = Promise.all([s.source.get(), s.source.get(), s.source.get()]);
    await new Promise((r) => setTimeout(r, 5));
    release(jsonRes(A));
    const got = await all;
    expect(got.map((m) => m?.version)).toEqual([A.version, A.version, A.version]);
    expect(s.up.calls).toHaveLength(1);
  });

  it("refuses a body over 1 MiB (declared or streamed)", async () => {
    const big = "x".repeat(APP_UPDATE_SOURCE_MAX_BYTES + 1);
    const s = setup(() => new Response(big, { status: 200 }));
    expect(await s.source.get()).toBeNull();
    const declared = setup(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(APP_UPDATE_SOURCE_MAX_BYTES + 1) },
        }),
    );
    expect(await declared.source.get()).toBeNull();
  });

  it("times out a hanging upstream (abort signal) and logs timeout", async () => {
    const { log, lines } = captureLog();
    const src = createManifestSource({
      url: URL_,
      log,
      timeoutMs: 30,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
    });
    expect(await src.get()).toBeNull();
    expect(lines.some((l) => (l.obj as { outcome?: string }).outcome === "timeout")).toBe(true);
  });

  it("logs one line per distinct failure and one on recovery, never the URL or body", async () => {
    const s = setup(() => jsonRes("secret-body-text", 500));
    await s.source.get();
    s.advance(APP_UPDATE_SOURCE_RETRY_MS);
    await s.source.get();
    s.advance(APP_UPDATE_SOURCE_RETRY_MS);
    await s.source.get();
    const warn = s.lines.filter((l) => l.level === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]?.obj).toMatchObject({ outcome: "http_error", status: 500 });
    s.up.respond(() => jsonRes("nope", 404));
    s.advance(APP_UPDATE_SOURCE_RETRY_MS);
    await s.source.get();
    expect(s.lines.filter((l) => l.level === "warn")).toHaveLength(2);
    s.up.respond(() => jsonRes(A));
    s.advance(APP_UPDATE_SOURCE_RETRY_MS);
    await s.source.get();
    const info = s.lines.filter((l) => l.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0]?.obj).toEqual({ outcome: "ok" });
    const all = JSON.stringify(s.lines);
    expect(all).not.toContain("web.internal.test");
    expect(all).not.toContain("secret-body-text");
    expect(all).not.toContain(A.version);
  });

  it("asks with redirect: error (no redirect to an attacker origin)", async () => {
    let init: RequestInit | undefined;
    const { log } = captureLog();
    const src = createManifestSource({
      url: URL_,
      log,
      fetch: (async (_u: unknown, i?: RequestInit) => {
        init = i;
        return jsonRes(A);
      }) as typeof fetch,
    });
    await src.get();
    expect(init?.redirect).toBe("error");
  });
});
