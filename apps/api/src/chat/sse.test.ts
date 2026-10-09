import { CHAT_SSE_KEEPALIVE, type ChatEvent, decodeChatEventFrame } from "@littlelight/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openChatEventStream } from "./sse";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) await a.close();
});

const U = "11111111-1111-4111-8111-111111111111";

describe("openChatEventStream", () => {
  it("opens with a comment, sends valid chat events in order, then closes; headers disable buffering", async () => {
    const app = Fastify();
    apps.push(app);
    const events: ChatEvent[] = [
      { type: "thread", threadId: U, userMessageId: U },
      { type: "status", stage: "thinking" },
      { type: "delta", text: "hello\nworld" },
    ];
    app.get("/s", async (_req, reply) => {
      const s = openChatEventStream(reply);
      for (const e of events) expect(s.send(e)).toBe(true);
      s.close();
      expect(s.send({ type: "delta", text: "late" })).toBe(false);
      return reply;
    });
    const res = await app.inject({ method: "GET", url: "/s" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    const frames = res.body.split("\n\n").filter(Boolean);
    expect(frames[0]).toBe(": stream open");
    expect(frames.slice(1).map((f) => decodeChatEventFrame(f))).toEqual(events);
    expect(res.body).not.toContain("late");
  });

  it("writes a keepalive comment every 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = Fastify();
    apps.push(app);
    app.get("/s", async (_req, reply) => {
      const s = openChatEventStream(reply);
      vi.advanceTimersByTime(14_999);
      s.send({ type: "status", stage: "thinking" });
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(15_000);
      s.close();
      // no more timers after close
      vi.advanceTimersByTime(60_000);
      return reply;
    });
    const res = await app.inject({ method: "GET", url: "/s" });
    expect(res.body.split(CHAT_SSE_KEEPALIVE).length - 1).toBe(2);
    expect(res.body.indexOf("event: status")).toBeLessThan(res.body.indexOf(CHAT_SSE_KEEPALIVE));
  });
});
