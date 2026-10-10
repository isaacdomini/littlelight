import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/errors";
import { signAccessToken, TEST_PUBLIC_URL, testConfig, unsignedToken } from "../testing/support";
import { JWT_CLOCK_TOLERANCE_SEC, verifyAccessToken } from "./jwt";

const config = testConfig();
const now = () => Math.floor(Date.now() / 1000);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return (err as ApiError).code;
  }
  throw new Error("expected verifyAccessToken to reject");
}

describe("verifyAccessToken", () => {
  it("accepts a GoTrue-shaped token and returns the parsed claims", async () => {
    const sub = randomUUID();
    const sessionId = randomUUID();
    const claims = await verifyAccessToken(
      await signAccessToken({ sub, sessionId, email: "a@b.co" }),
      config,
    );
    expect(claims).toMatchObject({
      sub,
      session_id: sessionId,
      role: "authenticated",
      email: "a@b.co",
    });
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await signAccessToken({ secret: "x".repeat(40) });
    expect(await codeOf(verifyAccessToken(token, config))).toBe("unauthorized");
  });

  it("rejects the wrong issuer and the wrong audience", async () => {
    expect(
      await codeOf(
        verifyAccessToken(await signAccessToken({ issuer: "http://evil.example/auth" }), config),
      ),
    ).toBe("unauthorized");
    expect(
      await codeOf(verifyAccessToken(await signAccessToken({ audience: "anon" }), config)),
    ).toBe("unauthorized");
  });

  it("derives the issuer from PUBLIC_URL", async () => {
    const other = testConfig({ PUBLIC_URL: "https://tinyglow.example" });
    const token = await signAccessToken({ issuer: "https://tinyglow.example/auth" });
    expect((await verifyAccessToken(token, other)).role).toBe("authenticated");
    // The same token no longer verifies against the dev issuer.
    expect(await codeOf(verifyAccessToken(token, config))).toBe("unauthorized");
    expect(TEST_PUBLIC_URL).toBe("http://localhost:8080");
  });

  it("rejects alg none, with and without a payload that would otherwise pass", async () => {
    const payload = {
      sub: randomUUID(),
      role: "authenticated",
      session_id: randomUUID(),
      aud: "authenticated",
      iss: `${TEST_PUBLIC_URL}/auth`,
      exp: now() + 3600,
    };
    expect(await codeOf(verifyAccessToken(unsignedToken(payload), config))).toBe("unauthorized");
  });

  it("rejects RS256 and other HMAC sizes (algorithm confusion)", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const rs = await new SignJWT({
      sub: randomUUID(),
      role: "authenticated",
      session_id: randomUUID(),
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(`${TEST_PUBLIC_URL}/auth`)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await codeOf(verifyAccessToken(rs, config))).toBe("unauthorized");
    // Public key material used as an HMAC secret must not help either.
    const jwk = JSON.stringify(await exportJWK(publicKey));
    const confused = await signAccessToken({ secret: jwk.padEnd(40, "x") });
    expect(await codeOf(verifyAccessToken(confused, config))).toBe("unauthorized");
    expect(await codeOf(verifyAccessToken(await signAccessToken({ alg: "HS384" }), config))).toBe(
      "unauthorized",
    );
  });

  it("reports an expired token as token_expired, honouring a small clock tolerance", async () => {
    const t = now();
    const expired = await signAccessToken({ iat: t - 7200, exp: t - 3600 });
    expect(await codeOf(verifyAccessToken(expired, config))).toBe("token_expired");

    const justExpired = await signAccessToken({ iat: t - 3600, exp: t - 1 });
    expect((await verifyAccessToken(justExpired, config)).role).toBe("authenticated");

    const beyond = await signAccessToken({
      iat: t - 3600,
      exp: t - JWT_CLOCK_TOLERANCE_SEC - 5,
    });
    expect(await codeOf(verifyAccessToken(beyond, config))).toBe("token_expired");
  });

  it("uses the injected clock", async () => {
    const t = now();
    const token = await signAccessToken({ iat: t, exp: t + 3600 });
    const later = new Date((t + 7200) * 1000);
    expect(await codeOf(verifyAccessToken(token, config, later))).toBe("token_expired");
  });

  it("rejects service_role / anon tokens even with a valid signature", async () => {
    for (const role of ["service_role", "anon", "viewer"]) {
      const token = await signAccessToken({ role });
      expect(await codeOf(verifyAccessToken(token, config))).toBe("unauthorized");
    }
  });

  it("rejects a token without sub or session_id, or with non-uuid ones", async () => {
    expect(await codeOf(verifyAccessToken(await signAccessToken({ sub: "" }), config))).toBe(
      "unauthorized",
    );
    expect(
      await codeOf(verifyAccessToken(await signAccessToken({ sessionId: null }), config)),
    ).toBe("unauthorized");
    expect(
      await codeOf(verifyAccessToken(await signAccessToken({ sessionId: "not-a-uuid" }), config)),
    ).toBe("unauthorized");
    expect(await codeOf(verifyAccessToken(await signAccessToken({ sub: "42" }), config))).toBe(
      "unauthorized",
    );
  });

  it("rejects garbage", async () => {
    for (const t of ["", "abc", "a.b.c", "Bearer x"]) {
      expect(await codeOf(verifyAccessToken(t, config))).toBe("unauthorized");
    }
  });

  it("never puts the token in the error", async () => {
    const token = await signAccessToken({ secret: "y".repeat(40) });
    try {
      await verifyAccessToken(token, config);
      expect.unreachable();
    } catch (err) {
      expect(JSON.stringify((err as ApiError).toBody())).not.toContain(token);
      expect((err as Error).message).not.toContain(token);
    }
  });
});
