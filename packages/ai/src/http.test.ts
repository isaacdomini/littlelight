import { describe, expect, it, vi } from "vitest";
import { AiProviderError } from "./errors";
import { HttpClient, providerErrorCode, splitLines } from "./http";
import { startMockServer } from "./testing/mock-http";

async function collect(gen: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const l of gen) out.push(l);
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: Uint8Array[]) {
  for (const p of parts) yield p;
}

describe("splitLines", () => {
  it("splits a 3-line file mid-line across chunks", async () => {
    const text = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const bytes = enc(text);
    expect(
      await collect(splitLines(chunks(bytes.slice(0, 5), bytes.slice(5, 13), bytes.slice(13)))),
    ).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  it("handles CRLF, blank lines, and a missing trailing newline", async () => {
    expect(await collect(splitLines(chunks(enc("a\r\n\r\nb\n\n   \nc"))))).toEqual(["a", "b", "c"]);
  });
  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = enc("é\nñ\n");
    expect(
      await collect(splitLines(chunks(bytes.slice(0, 1), bytes.slice(1, 4), bytes.slice(4)))),
    ).toEqual(["é", "ñ"]);
  });
  it("empty input yields nothing", async () => {
    expect(await collect(splitLines(chunks()))).toEqual([]);
  });
});

describe("providerErrorCode", () => {
  it("prefers a short code, then type, else http_<status>; rejects long / odd strings", () => {
    expect(providerErrorCode({ error: { code: "rate_limit_exceeded", type: "x" } }, 429)).toBe(
      "rate_limit_exceeded",
    );
    expect(providerErrorCode({ error: { code: null, type: "invalid_request_error" } }, 400)).toBe(
      "invalid_request_error",
    );
    expect(
      providerErrorCode({ error: { code: "has spaces and a very long message ".repeat(5) } }, 500),
    ).toBe("http_500");
    expect(providerErrorCode(undefined, 502)).toBe("http_502");
  });
});

describe("HttpClient", () => {
  const sleep = vi.fn(async () => undefined);

  it("retries an idempotent request on 503 and succeeds", async () => {
    let n = 0;
    const server = await startMockServer(() =>
      ++n < 3
        ? { status: 503, json: { error: { type: "api_error" } } }
        : { status: 200, json: { ok: 1 } },
    );
    const c = new HttpClient({
      provider: "t",
      baseUrl: server.baseUrl,
      headers: {},
      sleep,
      retryBaseMs: 1,
    });
    const res = await c.request({ op: "x", method: "GET", path: "/a", retry: "idempotent" });
    expect(res.body).toEqual({ ok: 1 });
    expect(n).toBe(3);
    await server.close();
  });

  it("does NOT retry a 500 on a rate_limit_only request (batch create / upload)", async () => {
    let n = 0;
    const server = await startMockServer(() => {
      n++;
      return { status: 500, json: { error: { type: "api_error" } } };
    });
    const c = new HttpClient({ provider: "t", baseUrl: server.baseUrl, headers: {}, sleep });
    await expect(
      c.request({
        op: "batches.create",
        method: "POST",
        path: "/a",
        json: {},
        retry: "rate_limit_only",
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
    expect(n).toBe(1);
    await server.close();
  });

  it("retries a 429 on rate_limit_only, honoring retry-after", async () => {
    const server = await startMockServer(() => ({ status: 200, json: { ok: true } }));
    server.injectFailure({ method: "POST", path: "/a", status: 429, times: 1, retryAfter: 2 });
    const s = vi.fn(async () => undefined);
    const c = new HttpClient({ provider: "t", baseUrl: server.baseUrl, headers: {}, sleep: s });
    const res = await c.request({
      op: "x",
      method: "POST",
      path: "/a",
      json: {},
      retry: "rate_limit_only",
    });
    expect(res.status).toBe(200);
    expect(s).toHaveBeenCalledWith(2000);
    await server.close();
  });

  it("gives up after maxRetries and the error has status + code, never the body", async () => {
    const server = await startMockServer(() => ({
      status: 503,
      json: { error: { message: "SECRET BODY TEXT", type: "overloaded" } },
    }));
    const c = new HttpClient({
      provider: "t",
      baseUrl: server.baseUrl,
      headers: {},
      sleep,
      maxRetries: 2,
    });
    const err = await c
      .request({ op: "x", method: "GET", path: "/a", retry: "idempotent" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("overloaded");
    expect(err.message).not.toContain("SECRET");
    expect(server.requests).toHaveLength(3);
    await server.close();
  });

  it("allowStatuses returns the 404 instead of throwing; network errors are code 'network'", async () => {
    const server = await startMockServer(() => ({
      status: 404,
      json: { error: { type: "not_found_error" } },
    }));
    const c = new HttpClient({ provider: "t", baseUrl: server.baseUrl, headers: {}, sleep });
    expect(
      (
        await c.request({
          op: "x",
          method: "DELETE",
          path: "/a",
          retry: "idempotent",
          allowStatuses: [404],
        })
      ).status,
    ).toBe(404);
    await server.close();
    const dead = new HttpClient({
      provider: "t",
      baseUrl: "http://127.0.0.1:1",
      headers: {},
      sleep,
      maxRetries: 1,
    });
    const err = await dead
      .request({ op: "x", method: "GET", path: "/a", retry: "idempotent" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("network");
    expect(err.status).toBe(0);
  });

  it("never logs request bodies", async () => {
    const server = await startMockServer(() => ({ status: 200, json: {} }));
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const c = new HttpClient({
      provider: "t",
      baseUrl: server.baseUrl,
      headers: { authorization: "Bearer sk-secret" },
      log,
      sleep,
    });
    await c.request({
      op: "x",
      method: "POST",
      path: "/a",
      json: { note: "PARENT-NOTE" },
      retry: "none",
    });
    const s = JSON.stringify([log.debug.mock.calls, log.info.mock.calls, log.warn.mock.calls]);
    expect(s).not.toContain("PARENT-NOTE");
    expect(s).not.toContain("sk-secret");
    await server.close();
  });

  it("sameOriginPath only follows the configured origin", () => {
    const c = new HttpClient({ provider: "t", baseUrl: "http://127.0.0.1:9", headers: {} });
    expect(c.sameOriginPath("/v1/x")).toBe("/v1/x");
    expect(c.sameOriginPath("http://127.0.0.1:9/v1/x?y=1")).toBe("/v1/x?y=1");
    expect(c.sameOriginPath("http://evil.example/v1/x")).toBeNull();
    expect(c.sameOriginPath("not a url")).toBeNull();
  });
});
