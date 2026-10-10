import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  clientCountry,
  clientDeviceLabel,
  clientIp,
  clientKind,
  clientKindHeader,
  clientUserAgent,
  isProxyPeerAddress,
  trustProxyHop,
  upstreamClientHeaders,
} from "./request";

type R = Parameters<typeof clientIp>[0];
const r = (headers: Record<string, string | string[]> = {}, ip = "10.0.0.1") =>
  ({ headers, ip }) as unknown as R;

describe("request facts", () => {
  it("clientIp prefers a valid CF-Connecting-IP, else request.ip", () => {
    expect(clientIp(r({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(r({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(r({ "cf-connecting-ip": "not-an-ip" }))).toBe("10.0.0.1");
    expect(clientIp(r({ "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }))).toBe("10.0.0.1");
    expect(clientIp(r())).toBe("10.0.0.1");
  });

  it("clientCountry uppercases and rejects malformed values", () => {
    expect(clientCountry(r({ "cf-ipcountry": "de" }))).toBe("DE");
    expect(clientCountry(r({ "cf-ipcountry": "XX" }))).toBe("XX");
    expect(clientCountry(r({ "cf-ipcountry": "T1" }))).toBe("T1");
    expect(clientCountry(r({ "cf-ipcountry": "DEU" }))).toBeNull();
    expect(clientCountry(r({ "cf-ipcountry": "<script>" }))).toBeNull();
    expect(clientCountry(r())).toBeNull();
  });

  it("clientKind is native only when declared; unknown values are null for the CSRF check", () => {
    expect(clientKindHeader(r({ "x-tinyglow-client": "web" }))).toBe("web");
    expect(clientKindHeader(r({ "x-tinyglow-client": "NATIVE" }))).toBe("native");
    expect(clientKindHeader(r({ "x-tinyglow-client": "other" }))).toBeNull();
    expect(clientKind(r({ "x-tinyglow-client": "other" }))).toBe("web");
    expect(clientKind(r({ "x-tinyglow-client": "native" }))).toBe("native");
    expect(clientKind(r())).toBe("web");
  });

  it("user agent is truncated and labelled coarsely", () => {
    expect(clientUserAgent(r({ "user-agent": "a".repeat(2000) }))?.length).toBe(512);
    expect(clientUserAgent(r())).toBeNull();
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    expect(clientDeviceLabel(r({ "user-agent": ua }))).toBe("Safari on iPhone");
    expect(clientDeviceLabel(r())).toBe("Unknown device");
  });

  it("upstream headers forward the real client and omit a missing UA", () => {
    expect(
      upstreamClientHeaders(r({ "cf-connecting-ip": "203.0.113.7", "user-agent": "UA" })),
    ).toEqual({
      "x-forwarded-for": "203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "UA",
    });
    expect(upstreamClientHeaders(r())).toEqual({
      "x-forwarded-for": "10.0.0.1",
      "cf-connecting-ip": "10.0.0.1",
    });
  });
});

describe("trustProxyHop (docs/plans/review-fixes.md D10: trust exactly one hop)", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.5", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["fd00::1", true],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["203.0.113.9", false],
    ["2001:db8::1", false],
    ["not-an-ip", false],
    ["", false],
  ])("isProxyPeerAddress(%j) is %s", (addr, expected) => {
    expect(isProxyPeerAddress(addr)).toBe(expected);
  });

  it("trusts hop 0 only, and only a private peer", () => {
    expect(trustProxyHop("172.18.0.5", 0)).toBe(true);
    expect(trustProxyHop("172.18.0.5", 1)).toBe(false);
    expect(trustProxyHop("172.18.0.5", 2)).toBe(false);
    expect(trustProxyHop("203.0.113.9", 0)).toBe(false);
  });

  async function ipSeenBy(remoteAddress: string, xff?: string) {
    const app = Fastify({ trustProxy: trustProxyHop });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress,
      headers: xff ? { "x-forwarded-for": xff } : {},
    });
    await app.close();
    return (res.json() as { ip: string }).ip;
  }

  it("a client-prepended X-Forwarded-For entry cannot choose request.ip", async () => {
    // nginx appends the real peer (198.51.100.20) to whatever the client sent.
    expect(await ipSeenBy("172.18.0.5", "6.6.6.6, 198.51.100.20")).toBe("198.51.100.20");
    expect(await ipSeenBy("172.18.0.5", "6.6.6.6, 7.7.7.7, 198.51.100.20")).toBe("198.51.100.20");
    expect(await ipSeenBy("172.18.0.5", "198.51.100.20")).toBe("198.51.100.20");
  });

  it("a direct client (not a proxy) cannot spoof X-Forwarded-For at all", async () => {
    expect(await ipSeenBy("203.0.113.9", "6.6.6.6")).toBe("203.0.113.9");
  });

  it("without a header the peer is the address", async () => {
    expect(await ipSeenBy("172.18.0.5")).toBe("172.18.0.5");
  });
});
