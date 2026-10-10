import { createHash, randomUUID } from "node:crypto";
import { SHARE_LINK_MAX_TTL_HOURS, shareTokenSchema } from "@tinyglow/shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "../auth/jwt";
import { signAccessToken, TEST_JWT_SECRET, TEST_PUBLIC_URL, testConfig } from "../testing/support";
import {
  hashClientIp,
  hashPasscode,
  hashShareToken,
  hashUserAgent,
  mintViewerJwt,
  newShareToken,
  shareIpKey,
  shareLinkUrl,
  ViewerJwtError,
  verifyPasscode,
  verifyViewerJwt,
  viewerJwtExp,
  viewerJwtIssuer,
  viewerJwtKey,
} from "./crypto";

// Share-link secrets (docs/plans/step-8.md 2.2; PRD "Security": share tokens >= 128-bit random,
// stored hashed). Pure crypto: no database, no network.

const config = testConfig();
const LINK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ViewerJwtError);
    return (err as ViewerJwtError).reason;
  }
  throw new Error("expected a rejection");
};

describe("share token", () => {
  it("is 22 base64url characters (128 bits) and accepted by the shared token schema", () => {
    for (let i = 0; i < 50; i++) {
      const { token } = newShareToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(16);
      expect(shareTokenSchema.safeParse(token).success).toBe(true);
    }
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newShareToken().token));
    expect(seen.size).toBe(500);
  });

  it("the stored hash is the SHA-256 of the token (32 bytes) and hashShareToken agrees", () => {
    const { token, hash } = newShareToken();
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash("sha256").update(token, "utf8").digest())).toBe(true);
    expect(hashShareToken(token).equals(hash)).toBe(true);
    expect(hashShareToken(`${token}x`).equals(hash)).toBe(false);
    // the hash never contains the token
    expect(hash.toString("hex")).not.toContain(token);
  });

  it("the URL is PUBLIC_URL + /s/ + token, with one slash however PUBLIC_URL ends", () => {
    expect(shareLinkUrl("https://x.example", "abc")).toBe("https://x.example/s/abc");
    expect(shareLinkUrl("https://x.example///", "abc")).toBe("https://x.example/s/abc");
  });
});

describe("passcode hashing", () => {
  it("has the format scrypt$1$16384$8$1$<salt>$<dk>", async () => {
    const h = await hashPasscode("482913");
    const parts = h.split("$");
    expect(parts.slice(0, 5)).toEqual(["scrypt", "1", "16384", "8", "1"]);
    expect(parts).toHaveLength(7);
    expect(Buffer.from(parts[5] ?? "", "base64url")).toHaveLength(16);
    expect(Buffer.from(parts[6] ?? "", "base64url")).toHaveLength(32);
    expect(h).not.toContain("482913");
  });

  it("uses a fresh salt each time", async () => {
    expect(await hashPasscode("123456")).not.toBe(await hashPasscode("123456"));
  });

  it("verifies the right code and refuses a wrong one", async () => {
    const h = await hashPasscode("482913");
    expect(await verifyPasscode("482913", h)).toBe(true);
    expect(await verifyPasscode("482914", h)).toBe(false);
    expect(await verifyPasscode("", h)).toBe(false);
    expect(await verifyPasscode("48291", h)).toBe(false);
    expect(await verifyPasscode("4829130", h)).toBe(false);
    expect(await verifyPasscode("abcdef", h)).toBe(false);
  });

  it("only hashes six ASCII digits", async () => {
    for (const bad of ["12345", "1234567", "12345a", "", " 12345", "１２３４５６"]) {
      await expect(hashPasscode(bad)).rejects.toThrow(RangeError);
    }
  });

  it("an argon2id hash (step 2 fixtures) or a corrupt hash never verifies (fail closed)", async () => {
    const good = await hashPasscode("482913");
    const parts = good.split("$");
    const corrupt = [
      "argon2id$fixture-passcode-hash",
      "argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
      "",
      "scrypt",
      "scrypt$x",
      `scrypt$2$16384$8$1$${parts.slice(5).join("$")}`,
      // work factor bombs and non powers of two
      `scrypt$1$${2 ** 30}$8$1$${parts[5]}$${parts[6]}`,
      `scrypt$1$16383$8$1$${parts[5]}$${parts[6]}`,
      `scrypt$1$16384$99$1$${parts[5]}$${parts[6]}`,
      `scrypt$1$16384$8$99$${parts[5]}$${parts[6]}`,
      `scrypt$1$0$8$1$${parts[5]}$${parts[6]}`,
      `scrypt$1$16384$8$1$$${parts[6]}`,
      `scrypt$1$16384$8$1$${parts[5]}$`,
      `scrypt$1$16384$8$1$${parts[5]}$!!!`,
      `${good}$extra`,
    ];
    for (const stored of corrupt) {
      expect(await verifyPasscode("482913", stored), stored.slice(0, 40)).toBe(false);
    }
  });

  it("a tampered derived key does not verify", async () => {
    const parts = (await hashPasscode("482913")).split("$");
    const dk = Buffer.from(parts[6] ?? "", "base64url");
    dk[0] = (dk[0] ?? 0) ^ 1;
    parts[6] = dk.toString("base64url");
    expect(await verifyPasscode("482913", parts.join("$"))).toBe(false);
  });
});

describe("derived keys", () => {
  it("the viewer JWT key and the IP hash key derived from JWT_SECRET differ, and differ from the secret", () => {
    const viewer = viewerJwtKey(config);
    const ip = shareIpKey(config);
    expect(viewer).toHaveLength(32);
    expect(ip).toHaveLength(32);
    expect(Buffer.from(viewer).equals(Buffer.from(ip))).toBe(false);
    expect(Buffer.from(viewer).equals(Buffer.from(TEST_JWT_SECRET))).toBe(false);
    expect(Buffer.from(ip).equals(Buffer.from(TEST_JWT_SECRET))).toBe(false);
  });

  it("depends on JWT_SECRET (another secret derives other keys) and is stable per secret", () => {
    const other = testConfig({ JWT_SECRET: "another-secret-at-least-32-characters-long" });
    expect(Buffer.from(viewerJwtKey(other)).equals(Buffer.from(viewerJwtKey(config)))).toBe(false);
    expect(Buffer.from(viewerJwtKey(config)).equals(Buffer.from(viewerJwtKey(testConfig())))).toBe(
      true,
    );
  });

  it("IP and user-agent hashes are keyed 32-byte values, stable per input, and never the raw input", () => {
    const a = hashClientIp(config, "203.0.113.7");
    expect(a).toHaveLength(32);
    expect(hashClientIp(config, "203.0.113.7").equals(a)).toBe(true);
    expect(hashClientIp(config, "203.0.113.8").equals(a)).toBe(false);
    // keyed: not the plain SHA-256 an attacker could brute force over IPv4
    expect(a.equals(createHash("sha256").update("203.0.113.7").digest())).toBe(false);
    expect(
      hashClientIp(
        testConfig({ JWT_SECRET: "another-secret-at-least-32-characters-long" }),
        "203.0.113.7",
      ).equals(a),
    ).toBe(false);
    // user agents hash by coarse label: two builds of the same browser collapse
    const ua1 =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const ua2 = ua1.replace("17_0", "17_1");
    expect(hashUserAgent(config, ua1).equals(hashUserAgent(config, ua2))).toBe(true);
    expect(hashUserAgent(config, null)).toHaveLength(32);
  });
});

describe("viewer JWT", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const mint = (over: { expiresAt?: Date; sessionId?: string; now?: Date } = {}) =>
    mintViewerJwt(config, {
      shareLinkId: LINK,
      sessionId: over.sessionId ?? randomUUID(),
      linkExpiresAt: over.expiresAt ?? new Date(now.getTime() + 24 * 3600_000),
      now: over.now ?? now,
    });

  it("round-trips with exactly the viewer claims and exp = the link's expiry", async () => {
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + 24 * 3600_000);
    const { token, exp } = await mint({ sessionId, expiresAt });
    expect(exp).toBe(Math.floor(expiresAt.getTime() / 1000));
    const claims = await verifyViewerJwt(token, config, now);
    expect(claims).toEqual({
      role: "viewer",
      share_link_id: LINK,
      jti: sessionId,
      iat: Math.floor(now.getTime() / 1000),
      exp,
    });
    // header and payload carry nothing else (no sub, no email, no token)
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "jti", "role", "share_link_id"].sort(),
    );
    expect(payload.aud).toBe("tinyglow-viewer");
    expect(payload.iss).toBe(viewerJwtIssuer(config));
    expect(payload.iss).toBe(`${TEST_PUBLIC_URL}/api/share`);
    expect(JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
  });

  it("caps exp at 720 hours (30 days) ahead whatever the link's expiry", async () => {
    const far = new Date(now.getTime() + 90 * 24 * 3600_000);
    const { exp } = await mint({ expiresAt: far });
    expect(exp).toBe(Math.floor((now.getTime() + SHARE_LINK_MAX_TTL_HOURS * 3600_000) / 1000));
    expect(viewerJwtExp(far, now)).toBe(exp);
    // a shorter link is not stretched
    const short = new Date(now.getTime() + 3600_000);
    expect(viewerJwtExp(short, now)).toBe(Math.floor(short.getTime() / 1000));
  });

  it("a GoTrue user token signed with JWT_SECRET does not verify as a viewer token", async () => {
    const userToken = await signAccessToken({ sub: randomUUID(), sessionId: randomUUID() });
    expect(await reasonOf(verifyViewerJwt(userToken, config))).toBe("invalid");
    // even one that mimics the viewer claims but is signed with the raw JWT_SECRET
    const forged = await new SignJWT({ role: "viewer", share_link_id: LINK })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(viewerJwtIssuer(config))
      .setAudience("tinyglow-viewer")
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti(randomUUID())
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));
    expect(await reasonOf(verifyViewerJwt(forged, config))).toBe("invalid");
  });

  it("a viewer JWT is rejected by the parent verifier", async () => {
    const { token } = await mint({ now: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
    await expect(verifyAccessToken(token, config)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("an expired token has reason `expired`; a 5 second skew is tolerated", async () => {
    const { token, exp } = await mint();
    expect(await reasonOf(verifyViewerJwt(token, config, new Date((exp + 60) * 1000)))).toBe(
      "expired",
    );
    await expect(verifyViewerJwt(token, config, new Date((exp + 3) * 1000))).resolves.toMatchObject(
      { role: "viewer" },
    );
  });

  it("a token without jti or iat, or with a non-uuid jti, is invalid", async () => {
    const sign = (claims: Record<string, unknown>, setup: (j: SignJWT) => SignJWT = (j) => j) =>
      setup(new SignJWT(claims))
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(viewerJwtIssuer(config))
        .setAudience("tinyglow-viewer")
        .setExpirationTime("1h")
        .sign(viewerJwtKey(config));
    const base = { role: "viewer", share_link_id: LINK };
    expect(await reasonOf(verifyViewerJwt(await sign(base, (j) => j.setIssuedAt()), config))).toBe(
      "invalid",
    ); // no jti
    expect(
      await reasonOf(verifyViewerJwt(await sign(base, (j) => j.setJti(randomUUID())), config)),
    ).toBe("invalid"); // no iat
    expect(
      await reasonOf(
        verifyViewerJwt(await sign(base, (j) => j.setIssuedAt().setJti("not-a-uuid")), config),
      ),
    ).toBe("invalid");
    // sanity: the same token with both is fine
    await expect(
      verifyViewerJwt(await sign(base, (j) => j.setIssuedAt().setJti(randomUUID())), config),
    ).resolves.toMatchObject({ role: "viewer" });
  });

  it("wrong role, wrong audience, wrong issuer, wrong algorithm and garbage are all invalid", async () => {
    const key = viewerJwtKey(config);
    const build = (o: { role?: string; aud?: string; iss?: string; alg?: string }) =>
      new SignJWT({ role: o.role ?? "viewer", share_link_id: LINK })
        .setProtectedHeader({ alg: o.alg ?? "HS256" })
        .setIssuer(o.iss ?? viewerJwtIssuer(config))
        .setAudience(o.aud ?? "tinyglow-viewer")
        .setIssuedAt()
        .setExpirationTime("1h")
        .setJti(randomUUID())
        .sign(key);
    for (const bad of [
      await build({ role: "authenticated" }),
      await build({ aud: "authenticated" }),
      await build({ iss: `${TEST_PUBLIC_URL}/auth` }),
      await build({ alg: "HS384" }),
      "garbage",
      "a.b.c",
      "",
    ]) {
      expect(await reasonOf(verifyViewerJwt(bad, config))).toBe("invalid");
    }
    expect(
      await reasonOf(
        verifyViewerJwt(`${(await build({})).split(".").slice(0, 2).join(".")}.`, config),
      ),
    ).toBe("invalid"); // alg none shape
  });

  it("ViewerJwtError messages never contain the token", async () => {
    const { token } = await mint();
    try {
      await verifyViewerJwt(`${token}x`, config);
    } catch (err) {
      expect(String(err)).not.toContain(token);
      expect((err as Error).message).toBe("viewer token invalid");
    }
  });
});
