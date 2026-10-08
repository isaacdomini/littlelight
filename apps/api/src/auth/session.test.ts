import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE_PATH,
  accessCookieOptions,
  clearSessionCookies,
  REFRESH_COOKIE_MAX_AGE_SEC,
  REFRESH_COOKIE_PATH,
  refreshCookieOptions,
  setSessionCookies,
} from "./session";

const dev = { NODE_ENV: "development" as const };
const prod = { NODE_ENV: "production" as const };

describe("cookie options", () => {
  it("ll_access: httpOnly, Lax, Path /api, one hour", () => {
    expect(accessCookieOptions(dev)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/api",
      maxAge: 3600,
      secure: false,
    });
    expect(ACCESS_COOKIE_PATH).toBe("/api");
  });

  it("ll_refresh: httpOnly, Strict, Path /api/auth, 30 days", () => {
    expect(refreshCookieOptions(dev)).toEqual({
      httpOnly: true,
      sameSite: "strict",
      path: "/api/auth",
      maxAge: 30 * 24 * 3600,
      secure: false,
    });
    expect(REFRESH_COOKIE_PATH).toBe("/api/auth");
    expect(REFRESH_COOKIE_MAX_AGE_SEC).toBe(2_592_000);
  });

  it("Secure only in production (not in dev or test)", () => {
    expect(accessCookieOptions(prod).secure).toBe(true);
    expect(refreshCookieOptions(prod).secure).toBe(true);
    expect(accessCookieOptions({ NODE_ENV: "test" }).secure).toBe(false);
    expect(refreshCookieOptions(dev).secure).toBe(false);
  });
});

async function setCookies(config: { NODE_ENV: "development" | "test" | "production" }) {
  const app = Fastify();
  await app.register(cookie);
  app.get("/set", async (_req, reply) => {
    setSessionCookies(reply, config, { accessToken: "AT", refreshToken: "RT" });
    return { ok: true };
  });
  app.get("/clear", async (_req, reply) => {
    clearSessionCookies(reply, config);
    return { ok: true };
  });
  const set = await app.inject({ method: "GET", url: "/set" });
  const clear = await app.inject({ method: "GET", url: "/clear" });
  await app.close();
  const lines = (r: typeof set) => [r.headers["set-cookie"]].flat().map(String);
  return { set: lines(set), clear: lines(clear) };
}

describe("Set-Cookie headers", () => {
  it("sets both cookies with the documented attributes (dev: no Secure)", async () => {
    const { set } = await setCookies(dev);
    const access = set.find((c) => c.startsWith("ll_access="));
    const refresh = set.find((c) => c.startsWith("ll_refresh="));
    expect(access).toMatch(/^ll_access=AT;/);
    expect(access).toContain("Path=/api;");
    expect(access).toContain("Max-Age=3600");
    expect(access).toContain("HttpOnly");
    expect(access).toContain("SameSite=Lax");
    expect(access).not.toContain("Secure");
    expect(refresh).toMatch(/^ll_refresh=RT;/);
    expect(refresh).toContain("Path=/api/auth;");
    expect(refresh).toContain("Max-Age=2592000");
    expect(refresh).toContain("HttpOnly");
    expect(refresh).toContain("SameSite=Strict");
    expect(refresh).not.toContain("Secure");
  });

  it("adds Secure in production", async () => {
    const { set } = await setCookies(prod);
    expect(set).toHaveLength(2);
    for (const line of set) expect(line).toContain("Secure");
  });

  it("clears with the same Path so browsers match, expiring in the past", async () => {
    const { clear } = await setCookies(prod);
    const access = clear.find((c) => c.startsWith("ll_access="));
    const refresh = clear.find((c) => c.startsWith("ll_refresh="));
    expect(access).toContain("Path=/api;");
    expect(refresh).toContain("Path=/api/auth;");
    for (const line of clear) {
      expect(line).toMatch(/^ll_(access|refresh)=;/);
      expect(line).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(line).toContain("Secure");
    }
  });
});
