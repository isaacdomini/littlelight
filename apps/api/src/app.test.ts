import { describe, expect, it } from "vitest";
import { loggerOptions, redactUrl } from "./app";

describe("redactUrl", () => {
  const TOKEN = "A".repeat(43);

  it("drops query strings entirely", () => {
    expect(redactUrl("/auth/callback?code=secret&state=x")).toBe("/auth/callback?[redacted]");
    expect(redactUrl("/healthz")).toBe("/healthz");
  });

  it("redacts the invite token segment and any token-shaped segment", () => {
    expect(redactUrl(`/invites/${TOKEN}`)).toBe("/invites/[redacted]");
    expect(redactUrl(`/invites/${TOKEN}/accept`)).toBe("/invites/[redacted]/accept");
    expect(redactUrl(`/invites/short`)).toBe("/invites/[redacted]");
    expect(redactUrl(`/something/${TOKEN}`)).toBe("/something/[redacted]");
  });

  it("keeps uuids readable", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(redactUrl(`/babies/${id}/members/${id}`)).toBe(`/babies/${id}/members/${id}`);
  });
});

describe("loggerOptions", () => {
  const opts = loggerOptions({ LOG_LEVEL: "info", NODE_ENV: "production" });

  it("redacts credentials, codes, tokens and client IPs", () => {
    for (const path of [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["cf-connecting-ip"]',
      'req.headers["x-forwarded-for"]',
      'res.headers["set-cookie"]',
      "req.body.email",
      "req.body.code",
      "req.body.tokenHash",
      "req.body.refreshToken",
      "req.body.idToken",
      "req.body.captchaToken",
    ]) {
      expect(opts.redact.paths).toContain(path);
    }
  });

  it("logs method, redacted url and route only", () => {
    const logged = opts.serializers.req({
      method: "GET",
      url: `/invites/${"B".repeat(43)}?x=1`,
      routeOptions: { url: "/invites/:token" },
    });
    expect(logged).toEqual({
      method: "GET",
      url: "/invites/[redacted]?[redacted]",
      route: "/invites/:token",
    });
  });
});
