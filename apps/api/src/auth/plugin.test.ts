import { describe, expect, it } from "vitest";
import { extractToken, needsCsrfHeader } from "./plugin";

type ExtractReq = Parameters<typeof extractToken>[0];
type CsrfReq = Parameters<typeof needsCsrfHeader>[0];

const req = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ headers, cookies }) as unknown as ExtractReq;

describe("extractToken", () => {
  it("reads a bearer header", () => {
    expect(extractToken(req({ authorization: "Bearer abc.def.ghi" }))).toEqual({
      token: "abc.def.ghi",
      transport: "bearer",
    });
    expect(extractToken(req({ authorization: "bearer   tok" }))?.token).toBe("tok");
  });

  it("falls back to the ll_access cookie", () => {
    expect(extractToken(req({}, { ll_access: "cookie-token" }))).toEqual({
      token: "cookie-token",
      transport: "cookie",
    });
  });

  it("prefers the bearer header over the cookie", () => {
    const got = extractToken(req({ authorization: "Bearer h" }, { ll_access: "c" }));
    expect(got).toEqual({ token: "h", transport: "bearer" });
  });

  it("does not fall through to the cookie when the header is malformed", () => {
    expect(extractToken(req({ authorization: "Basic abc" }, { ll_access: "c" }))).toBeNull();
    expect(extractToken(req({ authorization: "Bearer" }, { ll_access: "c" }))).toBeNull();
    expect(extractToken(req({ authorization: "Bearer a b" }, { ll_access: "c" }))).toBeNull();
  });

  it("ignores the refresh cookie and returns null with nothing presented", () => {
    expect(extractToken(req({}, { ll_refresh: "r" }))).toBeNull();
    expect(extractToken(req())).toBeNull();
  });
});

describe("needsCsrfHeader", () => {
  const c = (method: string, client?: string) =>
    ({
      method,
      headers: client ? { "x-tinyglow-client": client } : {},
      ip: "1.1.1.1",
    }) as unknown as CsrfReq;

  it("only applies to cookie transport on non-safe methods", () => {
    expect(needsCsrfHeader(c("POST"), "cookie")).toBe(true);
    expect(needsCsrfHeader(c("PATCH"), "cookie")).toBe(true);
    expect(needsCsrfHeader(c("DELETE"), "cookie")).toBe(true);
    expect(needsCsrfHeader(c("PUT"), "cookie")).toBe(true);
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(needsCsrfHeader(c(m), "cookie")).toBe(false);
    }
    expect(needsCsrfHeader(c("POST"), "bearer")).toBe(false);
  });

  it("is satisfied by exactly the web client header (case-insensitive value)", () => {
    expect(needsCsrfHeader(c("POST", "web"), "cookie")).toBe(false);
    expect(needsCsrfHeader(c("POST", "WEB"), "cookie")).toBe(false);
    expect(needsCsrfHeader(c("POST", "native"), "cookie")).toBe(true);
    expect(needsCsrfHeader(c("POST", "evil"), "cookie")).toBe(true);
  });
});
