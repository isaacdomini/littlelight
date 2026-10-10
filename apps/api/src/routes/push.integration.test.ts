import { randomUUID } from "node:crypto";
import { meResponseSchema, pushDeviceResponseSchema } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";

// Push device registration, notification preferences and native CORS against a real database
// (docs/plans/step-9.md 2.8, 2.15). The GoTrue session is the user's auth.sessions row.

const NATIVE = { "x-tinyglow-client": "native" };
const WEB = { "x-tinyglow-client": "web" };
const tok = () => `tok-${randomUUID().replaceAll("-", "")}`;
const body = (token = tok(), extra: Record<string, unknown> = {}) => ({
  platform: "ios",
  provider: "apns",
  token,
  appVersion: "1.0.0",
  ...extra,
});

describe.skipIf(!databaseUrl)("push devices (api + db)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const post = (u: TestUser | null, payload: unknown, headers: Record<string, string> = NATIVE) =>
    h.inject(u, "POST", "/me/push-devices", payload, headers);
  const devicesOf = async (u: TestUser) =>
    (
      await h.admin.query(
        "SELECT id, session_id, platform, provider, token, app_version, disabled_at FROM public.push_devices WHERE user_id = $1 ORDER BY created_at",
        [u.id],
      )
    ).rows;

  describe("POST /me/push-devices", () => {
    it("201 with the native header: stores one device bound to the caller's GoTrue session; the body never has the token", async () => {
      const u = await h.user();
      const token = tok();
      const res = await post(u, body(token));
      expect(res.statusCode, res.body).toBe(201);
      const parsed = pushDeviceResponseSchema.parse(res.json());
      expect(parsed.device.platform).toBe("ios");
      expect(res.body).not.toContain(token);
      const rows = await devicesOf(u);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: parsed.device.id,
        session_id: u.sessionId,
        platform: "ios",
        provider: "apns",
        token,
        app_version: "1.0.0",
        disabled_at: null,
      });
    });

    it("android registers with fcm", async () => {
      const u = await h.user();
      const res = await post(u, body(tok(), { platform: "android", provider: "fcm" }));
      expect(res.statusCode).toBe(201);
      expect(res.json().device.platform).toBe("android");
    });

    it("re-registering the same token keeps one row and the same id; a new token from the session replaces it", async () => {
      const u = await h.user();
      const t1 = tok();
      const a = await post(u, body(t1));
      const b = await post(u, body(t1, { appVersion: "1.0.1" }));
      expect(b.json().device.id).toBe(a.json().device.id);
      expect((await devicesOf(u))[0]?.app_version).toBe("1.0.1");
      await post(u, body(tok()));
      expect(await devicesOf(u)).toHaveLength(1);
    });

    it("two sessions of one user have two devices", async () => {
      const u = await h.user();
      const second = await h.session(u);
      await post(u, body());
      const res = await h.app.inject({
        method: "POST",
        url: "/me/push-devices",
        headers: { authorization: `Bearer ${second.token}`, ...NATIVE },
        payload: body(),
      });
      expect(res.statusCode).toBe(201);
      expect(await devicesOf(u)).toHaveLength(2);
    });

    it("a token seen on another user's session moves there (the previous user stops being notified)", async () => {
      const a = await h.user();
      const b = await h.user();
      const token = tok();
      await post(a, body(token));
      await post(b, body(token));
      expect(await devicesOf(a)).toHaveLength(0);
      expect(await devicesOf(b)).toHaveLength(1);
    });

    it("400 validation_failed without the native header (none or web), and nothing is stored", async () => {
      const u = await h.user();
      for (const headers of [{}, WEB]) {
        const res = await post(u, body(), headers);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("validation_failed");
      }
      expect(await devicesOf(u)).toHaveLength(0);
    });

    it("401 without credentials; 401 session_revoked once the session row is gone", async () => {
      expect((await post(null, body())).statusCode).toBe(401);
      const u = await h.user();
      await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [u.sessionId]);
      const res = await post(u, body());
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("session_revoked");
    });

    it("403 consent_required without accepted terms and registers nothing", async () => {
      const u = await h.user({ consent: false });
      const res = await post(u, body());
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("consent_required");
      expect(await devicesOf(u)).toHaveLength(0);
    });

    it.each([
      ["ios with fcm", { provider: "fcm" }],
      ["android with apns", { platform: "android" }],
      ["a short token", { token: "short" }],
      ["a token with whitespace", { token: "abcd efgh ijkl mnop" }],
      ["an extra key", { userId: "x" }],
    ])("400 for %s, never echoing the token", async (_n, patch) => {
      const u = await h.user();
      const res = await post(u, { ...body(), ...patch });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("abcd efgh");
      expect(await devicesOf(u)).toHaveLength(0);
    });

    it("429 after 20 registrations an hour for one user, with Retry-After", async () => {
      const u = await h.user();
      for (let i = 0; i < 20; i++) {
        expect((await post(u, body())).statusCode, `request ${i + 1}`).toBe(201);
      }
      const res = await post(u, body());
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("rate_limited");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      // Another user is unaffected.
      const other = await h.user();
      expect((await post(other, body())).statusCode).toBe(201);
    });

    it("the token is never in the API log lines", async () => {
      const lines: string[] = [];
      const logged = await createHarness({
        logger: {
          level: "info",
          stream: { write: (s: string) => void lines.push(s) },
          redact: { paths: ["req.body.token"], censor: "[redacted]" },
        },
      });
      try {
        const u = await logged.user();
        const token = tok();
        const res = await logged.inject(u, "POST", "/me/push-devices", body(token), NATIVE);
        expect(res.statusCode).toBe(201);
        expect(lines.join("\n")).not.toContain(token);
      } finally {
        await logged.close();
      }
    });
  });

  describe("DELETE /me/push-devices/current", () => {
    it("204, removes only this session's device and is idempotent", async () => {
      const u = await h.user();
      const second = await h.session(u);
      await post(u, body());
      await h.app.inject({
        method: "POST",
        url: "/me/push-devices",
        headers: { authorization: `Bearer ${second.token}`, ...NATIVE },
        payload: body(),
      });
      const first = await h.inject(u, "DELETE", "/me/push-devices/current");
      expect(first.statusCode).toBe(204);
      const rows = await devicesOf(u);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.session_id).toBe(second.id);
      expect((await h.inject(u, "DELETE", "/me/push-devices/current")).statusCode).toBe(204);
      expect(await devicesOf(u)).toHaveLength(1);
    });

    it("never touches another user's devices", async () => {
      const a = await h.user();
      const b = await h.user();
      await post(b, body());
      expect((await h.inject(a, "DELETE", "/me/push-devices/current")).statusCode).toBe(204);
      expect(await devicesOf(b)).toHaveLength(1);
    });

    it("works without the native header or consent, but not without auth", async () => {
      const u = await h.user({ consent: false });
      expect(
        (await h.inject(u, "DELETE", "/me/push-devices/current", undefined, WEB)).statusCode,
      ).toBe(204);
      expect((await h.inject(null, "DELETE", "/me/push-devices/current")).statusCode).toBe(401);
    });
  });

  describe("sign-out removes the push device", () => {
    it("POST /auth/signout deletes this session's device (and the audit row is still written)", async () => {
      const u = await h.user();
      const second = await h.session(u);
      await post(u, body());
      await h.app.inject({
        method: "POST",
        url: "/me/push-devices",
        headers: { authorization: `Bearer ${second.token}`, ...NATIVE },
        payload: body(),
      });
      const res = await h.inject(u, "POST", "/auth/signout", { scope: "local" }, NATIVE);
      expect(res.statusCode, res.body).toBeLessThan(300);
      const rows = await devicesOf(u);
      expect(rows.map((r) => r.session_id)).toEqual([second.id]);
      expect(await h.audit({ event: "auth.sign_out", actor: u.id })).toHaveLength(1);
    });
  });

  describe("notification preferences", () => {
    it("default to true and appear on GET /me", async () => {
      const u = await h.user();
      const me = meResponseSchema.parse((await h.inject(u, "GET", "/me")).json());
      expect(me.profile).toMatchObject({ notifyPhotosAnalyzed: true, notifyShareViewed: true });
    });

    it("PATCH /me/profile with only notify fields round-trips, each independently", async () => {
      const u = await h.user();
      const a = await h.inject(u, "PATCH", "/me/profile", { notifyPhotosAnalyzed: false });
      expect(a.statusCode, a.body).toBe(200);
      expect(meResponseSchema.parse(a.json()).profile).toMatchObject({
        notifyPhotosAnalyzed: false,
        notifyShareViewed: true,
      });
      const b = await h.inject(u, "PATCH", "/me/profile", { notifyShareViewed: false });
      expect(meResponseSchema.parse(b.json()).profile).toMatchObject({
        notifyPhotosAnalyzed: false,
        notifyShareViewed: false,
      });
      const c = await h.inject(u, "PATCH", "/me/profile", {
        notifyPhotosAnalyzed: true,
        displayName: "Maria",
      });
      expect(meResponseSchema.parse(c.json()).profile).toMatchObject({
        notifyPhotosAnalyzed: true,
        notifyShareViewed: false,
        displayName: "Maria",
      });
      expect(
        meResponseSchema.parse((await h.inject(u, "GET", "/me")).json()).profile,
      ).toMatchObject({
        notifyPhotosAnalyzed: true,
        notifyShareViewed: false,
      });
    });

    it("rejects a non-boolean value and an empty patch", async () => {
      const u = await h.user();
      expect(
        (await h.inject(u, "PATCH", "/me/profile", { notifyShareViewed: "no" })).statusCode,
      ).toBe(400);
      expect((await h.inject(u, "PATCH", "/me/profile", {})).statusCode).toBe(400);
    });

    it("only changes the caller's own row", async () => {
      const a = await h.user();
      const b = await h.user();
      await h.inject(a, "PATCH", "/me/profile", { notifyShareViewed: false });
      const r = await h.admin.query(
        "SELECT notify_share_viewed FROM public.profiles WHERE user_id = $1",
        [b.id],
      );
      expect(r.rows[0]?.notify_share_viewed).toBe(true);
    });
  });

  describe("native CORS through the real app", () => {
    it("a preflight from capacitor://localhost is answered 204 without credentials, before auth", async () => {
      const res = await h.app.inject({
        method: "OPTIONS",
        url: "/me/push-devices",
        headers: {
          origin: "capacitor://localhost",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type,x-tinyglow-client",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(String(res.headers["access-control-allow-headers"])).toContain("x-tinyglow-client");
    });

    it("an authenticated native request carries allow-origin, and 401s carry it too", async () => {
      const u = await h.user();
      const ok = await h.inject(u, "GET", "/me", undefined, {
        ...NATIVE,
        origin: "https://localhost",
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["access-control-allow-origin"]).toBe("https://localhost");
      const denied = await h.inject(null, "GET", "/me", undefined, {
        ...NATIVE,
        origin: "https://localhost",
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers["access-control-allow-origin"]).toBe("https://localhost");
    });

    it("an allowed origin without the native header is 403 csrf_rejected even with a valid bearer token", async () => {
      const u = await h.user();
      const res = await h.inject(u, "GET", "/me", undefined, { origin: "capacitor://localhost" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("csrf_rejected");
    });

    it("an unknown origin gets no CORS headers (and the same-origin web path is unchanged)", async () => {
      const u = await h.user();
      const res = await h.inject(u, "GET", "/me", undefined, { origin: "https://evil.example" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      const web = await h.inject(u, "GET", "/me");
      expect(web.statusCode).toBe(200);
    });

    it("honours a custom NATIVE_APP_ORIGINS list", async () => {
      const custom = await createHarness({
        config: { NATIVE_APP_ORIGINS: ["http://10.0.2.2:5173"] },
      });
      try {
        const yes = await custom.app.inject({
          method: "OPTIONS",
          url: "/me",
          headers: { origin: "http://10.0.2.2:5173", "access-control-request-method": "GET" },
        });
        expect(yes.statusCode).toBe(204);
        const no = await custom.app.inject({
          method: "OPTIONS",
          url: "/me",
          headers: { origin: "capacitor://localhost", "access-control-request-method": "GET" },
        });
        expect(no.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await custom.close();
      }
    });
  });
});
