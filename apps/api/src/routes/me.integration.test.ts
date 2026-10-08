import { randomUUID } from "node:crypto";
import { meResponseSchema, PRIVACY_VERSION, TERMS_VERSION } from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness } from "../testing/integration";
import { signAccessToken } from "../testing/support";

// /me, /me/consent, /me/profile (docs/plans/step-3.md 2.4; PRD "Sign-up flow" steps 3-4).

describe.skipIf(!databaseUrl)("/me", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const consent = (
    u: Parameters<Harness["inject"]>[0],
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => h.inject(u, "POST", "/me/consent", body, headers);
  const good = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, isAdult: true };

  describe("GET /me", () => {
    it("401 without a session", async () => {
      expect((await h.inject(null, "GET", "/me")).statusCode).toBe(401);
    });

    it("a user with no profile row: profile null, consent not ok, not complete", async () => {
      const u = await h.user({ profile: false });
      const res = await h.inject(u, "GET", "/me");
      expect(res.statusCode).toBe(200);
      const me = meResponseSchema.parse(res.json());
      expect(me.profile).toBeNull();
      expect(me.consent).toEqual({
        ok: false,
        requiredTermsVersion: TERMS_VERSION,
        requiredPrivacyVersion: PRIVACY_VERSION,
      });
      expect(me.profileComplete).toBe(false);
      expect(me.babies).toEqual([]);
      expect(me.user).toEqual({ id: u.id, email: u.email });
    });

    it("a profile without consent is not complete", async () => {
      const u = await h.user({ consent: false });
      const me = meResponseSchema.parse((await h.inject(u, "GET", "/me")).json());
      expect(me.profile?.termsVersion).toBeNull();
      expect(me.consent.ok).toBe(false);
      expect(me.profileComplete).toBe(false);
    });

    it("consent with a current-version profile and a name is complete, lists its live babies and session freshness", async () => {
      const u = await h.user({ displayName: "Maria" });
      const babyId = await h.baby(u, "Mia");
      const me = meResponseSchema.parse((await h.inject(u, "GET", "/me")).json());
      expect(me.consent.ok).toBe(true);
      expect(me.profileComplete).toBe(true);
      expect(me.profile?.displayName).toBe("Maria");
      expect(me.babies).toEqual([
        expect.objectContaining({ id: babyId, name: "Mia", role: "admin", plan: "free" }),
      ]);
      expect(me.session.isFresh).toBe(true);
    });

    it("outdated stored versions mean consent is no longer ok", async () => {
      const u = await h.user();
      await h.admin.query(
        "UPDATE public.profiles SET terms_version = '2020-01-01' WHERE user_id = $1",
        [u.id],
      );
      const me = meResponseSchema.parse((await h.inject(u, "GET", "/me")).json());
      expect(me.consent.ok).toBe(false);
      expect(me.profileComplete).toBe(false);
    });

    it("an old session reports isFresh false", async () => {
      const u = await h.user({ sessionAgeMin: 30 });
      const me = meResponseSchema.parse((await h.inject(u, "GET", "/me")).json());
      expect(me.session.isFresh).toBe(false);
    });

    it("never shows another user's data", async () => {
      const a = await h.user({ displayName: "Alice" });
      const b = await h.user({ displayName: "Bob" });
      await h.baby(a, "Alice's baby");
      const me = meResponseSchema.parse((await h.inject(b, "GET", "/me")).json());
      expect(me.babies).toEqual([]);
      expect(me.profile?.displayName).toBe("Bob");
      expect(JSON.stringify(me)).not.toContain(a.email);
    });

    it("hides trashed babies from the list", async () => {
      const u = await h.user();
      const id = await h.baby(u, "Soon trashed");
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [id]);
      expect(meResponseSchema.parse((await h.inject(u, "GET", "/me")).json()).babies).toEqual([]);
    });
  });

  describe("POST /me/consent", () => {
    it("accepting records the versions and the IP country (never the IP)", async () => {
      const u = await h.user({ consent: false });
      const res = await consent(u, good, {
        "cf-ipcountry": "se",
        "cf-connecting-ip": "198.51.100.23",
      });
      expect(res.statusCode).toBe(200);
      expect(meResponseSchema.parse(res.json()).consent.ok).toBe(true);
      const { rows } = await h.admin.query(
        "SELECT terms_version, privacy_version, accepted_at, accepted_ip_country FROM public.profiles WHERE user_id = $1",
        [u.id],
      );
      expect(rows[0]).toMatchObject({
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        accepted_ip_country: "SE",
      });
      expect(rows[0].accepted_at).toBeInstanceOf(Date);
      expect(JSON.stringify(rows[0])).not.toContain("198.51.100.23");
    });

    it("works when the profile row does not exist yet (upsert)", async () => {
      const u = await h.user({ profile: false });
      const res = await consent(u, good);
      expect(res.statusCode).toBe(200);
      expect(meResponseSchema.parse(res.json()).consent.ok).toBe(true);
    });

    it("isAdult:false is 403 under_18 and stores nothing", async () => {
      const u = await h.user({ consent: false });
      const res = await consent(u, { ...good, isAdult: false });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("under_18");
      const { rows } = await h.admin.query(
        "SELECT terms_version, privacy_version, accepted_at, accepted_ip_country FROM public.profiles WHERE user_id = $1",
        [u.id],
      );
      expect(rows[0]).toEqual({
        terms_version: null,
        privacy_version: null,
        accepted_at: null,
        accepted_ip_country: null,
      });
    });

    it("under_18 also cannot revoke an existing acceptance's record by re-posting", async () => {
      const u = await h.user();
      const before = (
        await h.admin.query("SELECT accepted_at FROM public.profiles WHERE user_id = $1", [u.id])
      ).rows[0];
      await consent(u, { ...good, isAdult: false });
      const after = (
        await h.admin.query("SELECT accepted_at FROM public.profiles WHERE user_id = $1", [u.id])
      ).rows[0];
      expect(after.accepted_at).toEqual(before.accepted_at);
    });

    it("outdated versions are 409 consent_version_outdated with the required ones, nothing stored", async () => {
      const u = await h.user({ consent: false });
      for (const body of [
        { ...good, termsVersion: "2020-01-01" },
        { ...good, privacyVersion: "2020-01-01" },
      ]) {
        const res = await consent(u, body);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("consent_version_outdated");
        expect(res.json().details).toEqual({
          requiredTermsVersion: TERMS_VERSION,
          requiredPrivacyVersion: PRIVACY_VERSION,
        });
      }
      const { rows } = await h.admin.query(
        "SELECT terms_version FROM public.profiles WHERE user_id = $1",
        [u.id],
      );
      expect(rows[0].terms_version).toBeNull();
    });

    it("re-consent to the same versions keeps the original accepted_at and country", async () => {
      const u = await h.user({ consent: false });
      await consent(u, good, { "cf-ipcountry": "DE" });
      const first = (
        await h.admin.query(
          "SELECT accepted_at, accepted_ip_country FROM public.profiles WHERE user_id = $1",
          [u.id],
        )
      ).rows[0];
      await new Promise((r) => setTimeout(r, 20));
      const again = await consent(u, good, { "cf-ipcountry": "FR" });
      expect(again.statusCode).toBe(200);
      const second = (
        await h.admin.query(
          "SELECT accepted_at, accepted_ip_country FROM public.profiles WHERE user_id = $1",
          [u.id],
        )
      ).rows[0];
      expect(second.accepted_at).toEqual(first.accepted_at);
      expect(second.accepted_ip_country).toBe("DE");
    });

    it("moving from an old version records a new acceptance", async () => {
      const u = await h.user();
      await h.admin.query(
        "UPDATE public.profiles SET terms_version = '2020-01-01', accepted_at = now() - interval '1 year', accepted_ip_country = 'DE' WHERE user_id = $1",
        [u.id],
      );
      await consent(u, good, { "cf-ipcountry": "NL" });
      const row = (
        await h.admin.query(
          "SELECT terms_version, accepted_at, accepted_ip_country FROM public.profiles WHERE user_id = $1",
          [u.id],
        )
      ).rows[0];
      expect(row.terms_version).toBe(TERMS_VERSION);
      expect(row.accepted_ip_country).toBe("NL");
      expect(Date.now() - row.accepted_at.getTime()).toBeLessThan(60_000);
    });

    it("a malformed country header is stored as null", async () => {
      const u = await h.user({ consent: false });
      await consent(u, good, { "cf-ipcountry": "<script>" });
      const row = (
        await h.admin.query("SELECT accepted_ip_country FROM public.profiles WHERE user_id = $1", [
          u.id,
        ])
      ).rows[0];
      expect(row.accepted_ip_country).toBeNull();
    });

    it("rejects an invalid body", async () => {
      const u = await h.user({ consent: false });
      expect((await consent(u, { termsVersion: TERMS_VERSION })).statusCode).toBe(400);
      expect((await consent(u, { ...good, isAdult: "yes" })).statusCode).toBe(400);
    });

    it("the CSRF header is required on the cookie transport", async () => {
      const u = await h.user({ consent: false });
      const res = await h.app.inject({
        method: "POST",
        url: "/me/consent",
        cookies: { ll_access: u.token },
        payload: good,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("csrf_rejected");
      const ok = await h.app.inject({
        method: "POST",
        url: "/me/consent",
        cookies: { ll_access: u.token },
        headers: { "x-littlelight-client": "web" },
        payload: good,
      });
      expect(ok.statusCode).toBe(200);
    });
  });

  describe("PATCH /me/profile", () => {
    const patch = (u: Parameters<Harness["inject"]>[0], body: unknown) =>
      h.inject(u, "PATCH", "/me/profile", body);

    it("403 consent_required before consent", async () => {
      const u = await h.user({ consent: false });
      const res = await patch(u, { displayName: "Maria" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("consent_required");
      const row = (
        await h.admin.query("SELECT display_name FROM public.profiles WHERE user_id = $1", [u.id])
      ).rows[0];
      expect(row.display_name).not.toBe("Maria");
    });

    it("403 consent_required with no profile row at all", async () => {
      const u = await h.user({ profile: false });
      expect((await patch(u, { displayName: "Maria" })).json().error).toBe("consent_required");
    });

    it("updates name, label, units and timezone and returns the new /me", async () => {
      const u = await h.user();
      const res = await patch(u, {
        displayName: "  Maria  ",
        relationshipLabel: "Mom",
        timezone: "America/New_York",
        units: "imperial",
      });
      expect(res.statusCode).toBe(200);
      const me = meResponseSchema.parse(res.json());
      expect(me.profile).toMatchObject({
        displayName: "Maria",
        relationshipLabel: "Mom",
        timezone: "America/New_York",
        units: "imperial",
      });
      expect(me.profileComplete).toBe(true);
    });

    it("accepts Asia/Kolkata and UTC", async () => {
      const u = await h.user();
      for (const timezone of ["Asia/Kolkata", "UTC"]) {
        const res = await patch(u, { timezone });
        expect(res.statusCode, timezone).toBe(200);
        expect(res.json().profile.timezone).toBe(timezone);
      }
    });

    it("rejects a bad timezone with 400 validation_failed naming body.timezone", async () => {
      const u = await h.user();
      for (const timezone of ["Mars/Olympus", "+05:30", "America/New_York; DROP TABLE profiles"]) {
        const res = await patch(u, { timezone });
        expect(res.statusCode, timezone).toBe(400);
        expect(res.json().error).toBe("validation_failed");
        expect(res.json().details).toEqual({ fields: ["body.timezone"] });
      }
      const row = (
        await h.admin.query("SELECT timezone FROM public.profiles WHERE user_id = $1", [u.id])
      ).rows[0];
      expect(row.timezone).toBe("UTC");
    });

    it("rejects an empty body, a blank name and unknown units", async () => {
      const u = await h.user();
      expect((await patch(u, {})).statusCode).toBe(400);
      expect((await patch(u, { displayName: "   " })).statusCode).toBe(400);
      expect((await patch(u, { units: "stone" })).statusCode).toBe(400);
      expect((await patch(u, { displayName: "x".repeat(81) })).statusCode).toBe(400);
    });

    it("ignores fields it does not own (cannot touch consent columns or another user)", async () => {
      const u = await h.user();
      const other = await h.user({ displayName: "Other" });
      const res = await patch(u, {
        displayName: "New",
        termsVersion: "1999",
        userId: other.id,
        user_id: other.id,
      });
      expect(res.statusCode).toBe(200);
      const rows = (
        await h.admin.query(
          "SELECT user_id, display_name, terms_version FROM public.profiles WHERE user_id = ANY($1::uuid[]) ORDER BY display_name",
          [[u.id, other.id]],
        )
      ).rows;
      expect(rows.find((r) => r.user_id === other.id)?.display_name).toBe("Other");
      expect(rows.find((r) => r.user_id === u.id)).toMatchObject({
        display_name: "New",
        terms_version: TERMS_VERSION,
      });
    });

    it("401 for a token of a user that has no session", async () => {
      const token = await signAccessToken({ sub: randomUUID(), sessionId: randomUUID() });
      const res = await h.inject(
        null,
        "PATCH",
        "/me/profile",
        { displayName: "x" },
        { authorization: `Bearer ${token}` },
      );
      expect(res.statusCode).toBe(401);
    });
  });
});
