import { describe, expect, it, vi } from "vitest";
import { recordingLog } from "../testing/stubs";
import { CsamMatcherError, createCsamMatcher, NoopCsamMatcher, PhotoDnaMatcher } from "./safety";

const input = {
  sha256: Buffer.alloc(32, 1),
  image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  mime: "image/jpeg" as const,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createCsamMatcher", () => {
  it("none: a no-op matcher that never matches; info in dev, warn in production", async () => {
    const log = recordingLog();
    const m = createCsamMatcher({ CSAM_MATCHER: "none" }, log);
    expect(m).toBeInstanceOf(NoopCsamMatcher);
    expect(m.name).toBe("none");
    expect(await m.check(input)).toEqual({ matched: false });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({
      level: "info",
      msg: expect.stringContaining("CSAM matching disabled"),
    });

    const prod = recordingLog();
    createCsamMatcher({ CSAM_MATCHER: "none", NODE_ENV: "production" }, prod);
    expect(prod.lines[0]?.level).toBe("warn");
  });

  it("photodna without a key or endpoint fails at startup", () => {
    const log = recordingLog();
    expect(() => createCsamMatcher({ CSAM_MATCHER: "photodna" }, log)).toThrow(/PHOTODNA_API_KEY/);
    expect(() =>
      createCsamMatcher({ CSAM_MATCHER: "photodna", PHOTODNA_API_KEY: "k" }, log),
    ).toThrow(/PHOTODNA_ENDPOINT/);
    expect(() =>
      createCsamMatcher(
        { CSAM_MATCHER: "photodna", PHOTODNA_ENDPOINT: "https://x.test/match" },
        log,
      ),
    ).toThrow();
    expect(log.lines).toEqual([]);
  });

  it("photodna with key and endpoint builds the real matcher and never logs the key", () => {
    const log = recordingLog();
    const m = createCsamMatcher(
      {
        CSAM_MATCHER: "photodna",
        PHOTODNA_API_KEY: "super-secret-key",
        PHOTODNA_ENDPOINT: "https://x.test/match",
      },
      log,
    );
    expect(m.name).toBe("photodna");
    expect(JSON.stringify(log.lines)).not.toContain("super-secret-key");
  });
});

describe("PhotoDnaMatcher", () => {
  const make = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) =>
    new PhotoDnaMatcher({
      apiKey: "key-123",
      endpoint: "https://x.test/match",
      fetch: fetchImpl,
      timeoutMs: 50,
    });

  it("posts only the analysis JPEG with the subscription key header", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) =>
      json({ IsMatch: false, Status: { Code: 3000 } }),
    );
    await make(f).check(input);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.test/match");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("key-123");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
    expect(Buffer.from(init.body as Uint8Array)).toEqual(input.image);
  });

  it("no match, match with and without a tracking id", async () => {
    expect(await make(async () => json({ IsMatch: false })).check(input)).toEqual({
      matched: false,
    });
    expect(
      await make(async () =>
        json({ IsMatch: true, TrackingId: "T-1", Status: { Code: 3000 } }),
      ).check(input),
    ).toEqual({
      matched: true,
      reference: "T-1",
    });
    expect(await make(async () => json({ IsMatch: true })).check(input)).toEqual({
      matched: true,
      reference: undefined,
    });
  });

  it.each([
    ["a non-OK status code", json({ IsMatch: false, Status: { Code: 3201 } }), "bad_response"],
    ["a missing IsMatch", json({ Status: { Code: 3000 } }), "bad_response"],
    ["a non-boolean IsMatch", json({ IsMatch: "false" }), "bad_response"],
    ["null JSON", json(null), "bad_response"],
    ["invalid JSON", new Response("<html>oops</html>", { status: 200 }), "bad_response"],
    ["HTTP 500", json({}, 500), "http_500"],
    ["HTTP 401", json({}, 401), "http_401"],
    ["HTTP 429", json({}, 429), "http_429"],
  ])("throws CsamMatcherError for %s (fail closed, the job is retried)", async (_n, res, code) => {
    const err = await make(async () => res)
      .check(input)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CsamMatcherError);
    expect((err as CsamMatcherError).code).toBe(code);
  });

  it("network failures and timeouts are categorised without leaking the URL or key", async () => {
    const net = await make(async () => {
      throw new TypeError("fetch failed https://x.test/match key-123");
    })
      .check(input)
      .catch((e) => e);
    expect(net).toBeInstanceOf(CsamMatcherError);
    expect(net.code).toBe("network");
    expect(net.message).not.toContain("key-123");
    expect(net.message).not.toContain("x.test");

    const slow = await make(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("t"), { name: "TimeoutError" })),
          );
        }),
    )
      .check(input)
      .catch((e) => e);
    expect(slow.code).toBe("timeout");
  });
});
