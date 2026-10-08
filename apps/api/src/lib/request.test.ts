import { describe, expect, it } from "vitest";
import {
  clientCountry,
  clientDeviceLabel,
  clientIp,
  clientKind,
  clientKindHeader,
  clientUserAgent,
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
    expect(clientKindHeader(r({ "x-littlelight-client": "web" }))).toBe("web");
    expect(clientKindHeader(r({ "x-littlelight-client": "NATIVE" }))).toBe("native");
    expect(clientKindHeader(r({ "x-littlelight-client": "other" }))).toBeNull();
    expect(clientKind(r({ "x-littlelight-client": "other" }))).toBe("web");
    expect(clientKind(r({ "x-littlelight-client": "native" }))).toBe("native");
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
