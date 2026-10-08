import { describe, expect, it } from "vitest";
import { createThrottle } from "./throttle";

function make(limit = 3, windowMs = 10_000) {
  let t = 1_000_000;
  const throttle = createThrottle({ limit, windowMs, now: () => t });
  return {
    throttle,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("createThrottle", () => {
  it("allows up to the limit then denies with retryAfter", () => {
    const { throttle, advance } = make(3, 10_000);
    expect(throttle.hit("k").allowed).toBe(true);
    advance(1_000);
    expect(throttle.hit("k").allowed).toBe(true);
    advance(1_000);
    const third = throttle.hit("k");
    expect(third).toMatchObject({ allowed: true, count: 3, retryAfterSec: 0 });
    advance(1_000);
    const denied = throttle.hit("k");
    // Oldest hit was 3 s ago; the window is 10 s: 7 s remain.
    expect(denied).toMatchObject({ allowed: false, count: 3, retryAfterSec: 7 });
    throttle.close();
  });

  it("does not record denied hits (a denied caller does not extend its own ban)", () => {
    const { throttle, advance } = make(1, 10_000);
    throttle.hit("k");
    advance(5_000);
    expect(throttle.hit("k").allowed).toBe(false);
    expect(throttle.count("k")).toBe(1);
    advance(5_000);
    expect(throttle.hit("k").allowed).toBe(true);
    throttle.close();
  });

  it("slides: an old hit drops out of the window and frees a slot", () => {
    const { throttle, advance } = make(2, 10_000);
    throttle.hit("k");
    advance(6_000);
    throttle.hit("k");
    advance(5_000); // first hit is now 11 s old
    expect(throttle.count("k")).toBe(1);
    expect(throttle.hit("k").allowed).toBe(true);
    expect(throttle.hit("k").allowed).toBe(false);
    throttle.close();
  });

  it("rounds retryAfter up and never reports less than 1 second", () => {
    const { throttle, advance } = make(1, 10_000);
    throttle.hit("k");
    advance(9_999);
    expect(throttle.hit("k").retryAfterSec).toBe(1);
    throttle.close();
  });

  it("keeps keys independent and reset forgets one", () => {
    const { throttle } = make(1);
    throttle.hit("a");
    expect(throttle.hit("a").allowed).toBe(false);
    expect(throttle.hit("b").allowed).toBe(true);
    throttle.reset("a");
    expect(throttle.count("a")).toBe(0);
    expect(throttle.hit("a").allowed).toBe(true);
    throttle.close();
  });

  it("sweep drops expired entries", () => {
    const { throttle, advance } = make(5, 1_000);
    throttle.hit("a");
    advance(2_000);
    throttle.sweep();
    expect(throttle.count("a")).toBe(0);
    throttle.close();
  });

  it("exposes limit and window and validates its options", () => {
    const { throttle } = make(4, 2_000);
    expect(throttle.limit).toBe(4);
    expect(throttle.windowMs).toBe(2_000);
    throttle.close();
    expect(() => createThrottle({ limit: 0, windowMs: 1 })).toThrow();
    expect(() => createThrottle({ limit: 1.5, windowMs: 1 })).toThrow();
    expect(() => createThrottle({ limit: 1, windowMs: 0 })).toThrow();
  });

  it("close clears state", () => {
    const { throttle } = make(1);
    throttle.hit("a");
    throttle.close();
    expect(throttle.count("a")).toBe(0);
  });
});
