import { describe, expect, it } from "vitest";
import { createTurnstile, TURNSTILE_VERIFY_URL } from "./turnstile";

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fn, calls };
}

describe("createTurnstile", () => {
  it("is null without a secret (inert in dev and CI)", () => {
    expect(createTurnstile(undefined)).toBeNull();
    expect(createTurnstile("")).toBeNull();
  });

  it("posts secret, response and remoteip as a form and accepts success:true", async () => {
    const f = fakeFetch(() => Response.json({ success: true }));
    const ts = createTurnstile("sekret", { fetch: f.fn });
    expect(await ts?.verify("tok-1", "203.0.113.9")).toBe(true);
    const call = f.calls[0];
    expect(call?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(call?.init.method).toBe("POST");
    const body = new URLSearchParams(String(call?.init.body));
    expect(body.get("secret")).toBe("sekret");
    expect(body.get("response")).toBe("tok-1");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it("fails on success:false, non-2xx, malformed JSON and network errors", async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
      () => Response.json({ success: "true" }),
      () => new Response("nope", { status: 500 }),
      () => new Response("not json", { status: 200 }),
      () => {
        throw new Error("ECONNRESET");
      },
    ];
    for (const respond of cases) {
      const ts = createTurnstile("sekret", { fetch: fakeFetch(respond).fn });
      expect(await ts?.verify("t", "1.2.3.4")).toBe(false);
    }
  });

  it("times out and counts that as failure", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const ts = createTurnstile("sekret", { fetch: hang, timeoutMs: 20 });
    expect(await ts?.verify("t", "1.2.3.4")).toBe(false);
  });
});
