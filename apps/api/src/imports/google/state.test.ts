import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { TEST_JWT_SECRET, TEST_PUBLIC_URL } from "../../testing/support";
import {
  GOOGLE_STATE_AUDIENCE,
  GOOGLE_STATE_TTL_SEC,
  googleStateIssuer,
  googleStateKey,
  mintGoogleState,
  verifyGoogleState,
} from "./state";

const cfg = { JWT_SECRET: TEST_JWT_SECRET, PUBLIC_URL: TEST_PUBLIC_URL };
const UID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const input = { uid: UID, sessionId: SID, client: "web" as const, returnTo: "/upload" as const };

describe("Google OAuth state JWT", () => {
  it("round-trips the user, session, client and return path", async () => {
    const state = await mintGoogleState(cfg, input);
    const v = await verifyGoogleState(cfg, state);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims).toMatchObject({ sub: UID, sid: SID, client: "web", returnTo: "/upload" });
      expect(v.claims.exp - v.claims.iat).toBe(GOOGLE_STATE_TTL_SEC);
      expect(GOOGLE_STATE_TTL_SEC).toBe(600);
    }
  });

  it("carries a random jti per mint", async () => {
    const a = await mintGoogleState(cfg, input);
    const b = await mintGoogleState(cfg, input);
    expect(a).not.toBe(b);
  });

  it("expires after 10 minutes (plus the 5 s clock tolerance)", async () => {
    const now = new Date("2026-10-10T10:00:00Z");
    const state = await mintGoogleState(cfg, { ...input, now });
    expect((await verifyGoogleState(cfg, state, new Date(now.getTime() + 599_000))).ok).toBe(true);
    const late = await verifyGoogleState(cfg, state, new Date(now.getTime() + 620_000));
    expect(late).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a state signed with another secret", async () => {
    const state = await mintGoogleState({ ...cfg, JWT_SECRET: `${TEST_JWT_SECRET}-other` }, input);
    expect(await verifyGoogleState(cfg, state)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects the wrong audience, issuer or key purpose (a GoTrue or viewer token never verifies)", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const base = () =>
      new SignJWT({ sid: SID, client: "web", returnTo: "/upload" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(UID)
        .setJti(crypto.randomUUID())
        .setIssuedAt(iat)
        .setExpirationTime(iat + 300);
    const good = await base()
      .setIssuer(googleStateIssuer(cfg))
      .setAudience(GOOGLE_STATE_AUDIENCE)
      .sign(googleStateKey(cfg));
    expect((await verifyGoogleState(cfg, good)).ok).toBe(true);
    const wrongAud = await base()
      .setIssuer(googleStateIssuer(cfg))
      .setAudience("authenticated")
      .sign(googleStateKey(cfg));
    expect((await verifyGoogleState(cfg, wrongAud)).ok).toBe(false);
    const wrongIss = await base()
      .setIssuer("https://evil.test")
      .setAudience(GOOGLE_STATE_AUDIENCE)
      .sign(googleStateKey(cfg));
    expect((await verifyGoogleState(cfg, wrongIss)).ok).toBe(false);
    // Signed with the raw JWT secret (the GoTrue key), not the derived one.
    const rawKey = await base()
      .setIssuer(googleStateIssuer(cfg))
      .setAudience(GOOGLE_STATE_AUDIENCE)
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));
    expect((await verifyGoogleState(cfg, rawKey)).ok).toBe(false);
  });

  it("rejects alg none, tampering, garbage, empty and oversized input without throwing", async () => {
    const state = await mintGoogleState(cfg, input);
    const [h, p, s] = state.split(".");
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`;
    expect((await verifyGoogleState(cfg, none)).ok).toBe(false);
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: SID })).toString("base64url")}.${s}`;
    expect((await verifyGoogleState(cfg, tampered)).ok).toBe(false);
    for (const bad of [undefined, "", "not.a.jwt", "x".repeat(3000)])
      expect(await verifyGoogleState(cfg, bad)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a return path outside the allow-list even when correctly signed", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const evil = await new SignJWT({ sid: SID, client: "web", returnTo: "https://evil.test" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(UID)
      .setJti(crypto.randomUUID())
      .setIssuer(googleStateIssuer(cfg))
      .setAudience(GOOGLE_STATE_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .sign(googleStateKey(cfg));
    expect(await verifyGoogleState(cfg, evil)).toEqual({ ok: false, reason: "invalid" });
  });

  it("the state does not contain the session id in the clear outside the signed payload (no secrets beyond ids)", async () => {
    const state = await mintGoogleState(cfg, input);
    const payload = JSON.parse(Buffer.from(state.split(".")[1] ?? "", "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(
      ["aud", "client", "exp", "iat", "iss", "jti", "returnTo", "sid", "sub"].sort(),
    );
  });
});
