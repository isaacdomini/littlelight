import { CHAT_SSE_KEEPALIVE } from "@tinyglow/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openEventStream, SSE_HEADERS, sseFrame } from "./sse";

describe("sseFrame", () => {
  it("writes event and a single data line; newlines in data are JSON-escaped", () => {
    expect(sseFrame("delta", { text: "a\nb" })).toBe('event: delta\ndata: {"text":"a\\nb"}\n\n');
  });

  it("rejects event names that could inject lines", () => {
    for (const bad of ["a\nb", "A", "x y", "", "x".repeat(40), "data:"]) {
      expect(() => sseFrame(bad, {}), bad).toThrow("invalid SSE event name");
    }
  });
});

describe("headers", () => {
  it("are non-cacheable, non-transformable and unbuffered", () => {
    expect(SSE_HEADERS["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(SSE_HEADERS["cache-control"]).toBe("no-store, no-transform");
    expect(SSE_HEADERS["x-accel-buffering"]).toBe("no");
  });
});

describe("openEventStream", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  it("streams frames in order, with the SSE headers, and closes", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/s", async (_req, reply) => {
      const s = openEventStream(reply);
      s.send("one", { n: 1 });
      s.send("two", { n: 2 });
      s.close();
      expect(s.closed).toBe(true);
      // after close nothing more is written
      expect(s.send("three", {})).toBe(false);
      return reply;
    });
    const res = await app.inject({ method: "GET", url: "/s" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.body).toBe('event: one\ndata: {"n":1}\n\nevent: two\ndata: {"n":2}\n\n');
  });

  it("close is idempotent", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/s", async (_req, reply) => {
      const s = openEventStream(reply);
      s.close();
      s.close();
      return reply;
    });
    expect((await app.inject({ method: "GET", url: "/s" })).statusCode).toBe(200);
  });

  it("writes keepalive comments while idle", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/s", async (_req, reply) => {
      const s = openEventStream(reply, { keepaliveMs: 15 });
      s.send("a", {});
      await new Promise((r) => setTimeout(r, 80));
      s.send("b", {});
      s.close();
      return reply;
    });
    const res = await app.inject({ method: "GET", url: "/s" });
    const keepalives = res.body.split(CHAT_SSE_KEEPALIVE).length - 1;
    expect(keepalives).toBeGreaterThanOrEqual(2);
    expect(res.body.indexOf("event: a")).toBeLessThan(res.body.indexOf("event: b"));
    expect(res.body.endsWith("event: b\ndata: {}\n\n")).toBe(true);
  });
});
