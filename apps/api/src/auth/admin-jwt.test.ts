import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_JWT_SECRET, testConfig } from "../testing/support";
import { ADMIN_JWT_TTL_SEC, jwtIssuer, mintAdminJwt } from "./admin-jwt";
import { verifyAccessToken } from "./jwt";

const config = testConfig();

describe("mintAdminJwt", () => {
  it("is an HS256 service_role token valid for 60 seconds with no sub", async () => {
    const at = new Date("2026-10-08T12:00:00Z");
    const token = await mintAdminJwt(config, at);
    expect(decodeProtectedHeader(token).alg).toBe("HS256");
    const claims = decodeJwt(token);
    expect(claims.role).toBe("service_role");
    expect(claims).not.toHaveProperty("sub");
    expect(claims).not.toHaveProperty("session_id");
    expect(claims.iss).toBe(jwtIssuer(config));
    expect(claims.iat).toBe(Math.floor(at.getTime() / 1000));
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(ADMIN_JWT_TTL_SEC);
    expect(ADMIN_JWT_TTL_SEC).toBe(60);
  });

  it("verifies with JWT_SECRET (what GoTrue accepts) and not with another secret", async () => {
    const token = await mintAdminJwt(config);
    await expect(
      jwtVerify(token, new TextEncoder().encode(TEST_JWT_SECRET), { algorithms: ["HS256"] }),
    ).resolves.toBeTruthy();
    await expect(
      jwtVerify(token, new TextEncoder().encode("z".repeat(40)), { algorithms: ["HS256"] }),
    ).rejects.toThrow();
  });

  it("can never pass the user-token verifier", async () => {
    const token = await mintAdminJwt(config);
    await expect(verifyAccessToken(token, config)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
