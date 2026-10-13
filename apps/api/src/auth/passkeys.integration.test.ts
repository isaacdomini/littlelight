import {
  deletionPreviewResponseSchema,
  passkeySchema,
  sessionResponseSchema,
  sessionsListResponseSchema,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness } from "../testing/integration";
import { goTruePasskeyBody, goTruePasskeyOptionsBody, gotrueSession } from "../testing/support";
import { assertionCredential, FLAGS_UP_ONLY, registrationCredential } from "../testing/webauthn";
import { ensureWebauthnTables, passkeyRowCounts, seedPasskeyRows } from "../testing/webauthn-db";

// Passkeys against a real database (docs/plans/step-13.md 2.4, 2.8; 0.1 decision f): account
// deletion cascades GoTrue's credential/challenge rows, the deletion preview counts from GoTrue's
// list, a passkey sign-in writes `auth.sign_in { method: passkey }` and the devices list shows it,
// registration/removal write their audit rows and alerts, and the fresh-sign-in gate on removal
// is enforced against the real `auth.sessions.created_at`. GoTrue itself is the recording stub.

const WEB = { "x-tinyglow-client": "web" };
const PK_ID = "3f2c1b0a-1234-4abc-8def-0123456789ab";
const CH_ID = "7e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f";

describe.skipIf(!databaseUrl)("passkeys (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      config: { AUTH_PASSKEYS_ENABLED: true },
      gotrue: {
        passkeyList: async () => [],
        passkeyRegOptions: async () => goTruePasskeyOptionsBody({ challenge_id: CH_ID }),
        passkeyRegVerify: async () => goTruePasskeyBody({ id: PK_ID }),
        passkeyRename: async (_t, id, name) => goTruePasskeyBody({ id, friendly_name: name }),
        passkeyDelete: async () => undefined,
      },
    });
    await ensureWebauthnTables(h.admin);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("account deletion removes the user's GoTrue credential and challenge rows (0 / 0)", async () => {
    const u = await h.user();
    await seedPasskeyRows(h.admin, u.id);
    await seedPasskeyRows(h.admin, u.id);
    expect(await passkeyRowCounts(h.admin, u.id)).toEqual({ credentials: 2, challenges: 2 });
    const bystander = await h.user();
    await seedPasskeyRows(h.admin, bystander.id);

    const res = await h.inject(u, "DELETE", "/me", { acknowledge: true });
    expect(res.statusCode).toBe(204);
    expect(await passkeyRowCounts(h.admin, u.id)).toEqual({ credentials: 0, challenges: 0 });
    expect(await passkeyRowCounts(h.admin, bystander.id)).toEqual({
      credentials: 1,
      challenges: 1,
    });
    const users = await h.admin.query("SELECT 1 FROM auth.users WHERE id = $1", [u.id]);
    expect(users.rows).toHaveLength(0);
  });

  it("the deletion preview's passkeys count equals the stubbed GoTrue list length (and is 0 when GoTrue fails)", async () => {
    const u = await h.user();
    h.gotrue.impl.passkeyList = async () => [
      goTruePasskeyBody(),
      goTruePasskeyBody({ friendly_name: "Laptop" }),
      goTruePasskeyBody(),
    ];
    try {
      const res = await h.inject(u, "GET", "/me/deletion-preview");
      expect(res.statusCode).toBe(200);
      expect(deletionPreviewResponseSchema.parse(res.json()).passkeys).toBe(3);
      expect(h.gotrue.calls.passkeyList.at(-1)).toEqual([u.token]);
      h.gotrue.impl.passkeyList = async () => {
        throw new Error("gotrue unreachable");
      };
      const down = await h.inject(u, "GET", "/me/deletion-preview");
      expect(down.statusCode).toBe(200);
      expect(down.json().passkeys).toBe(0);
    } finally {
      h.gotrue.impl.passkeyList = async () => [];
    }
  });

  it("passkey sign-in: a real session row, audit auth.sign_in { method: passkey }, and the devices list shows the method", async () => {
    const u = await h.user();
    // GoTrue would create the session; the stub mirrors that with a live auth.sessions row.
    const second = await h.session(u, { userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" });
    h.gotrue.impl.passkeyAuthVerify = async () =>
      gotrueSession({ sub: u.id, email: u.email, sessionId: second.id });
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/auth/passkey/verify",
        headers: { ...WEB, "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1" },
        payload: { challengeId: CH_ID, credential: assertionCredential() },
      });
      expect(res.statusCode).toBe(200);
      const body = sessionResponseSchema.parse(res.json());
      expect(body.user.id).toBe(u.id);
      expect(body.session.isFresh).toBe(true);
      const signIns = await h.audit({ event: "auth.sign_in", actor: u.id });
      expect(signIns).toHaveLength(1);
      expect(signIns[0]?.metadata).toMatchObject({ method: "passkey", client: "web" });
      expect(JSON.stringify(signIns[0]?.metadata)).not.toContain(CH_ID);
      // two live sessions now: the new-device alert went out
      expect(h.mailer.sent.some((m) => m.template === "new_device" && m.to === u.email)).toBe(true);
      // the devices list names the method for that session
      const list = await h.inject(u, "GET", "/auth/sessions");
      expect(list.statusCode).toBe(200);
      const sessions = sessionsListResponseSchema.parse(list.json());
      const mine = sessions.sessions.find((s) => s.id === second.id);
      expect(mine?.signInMethod).toBe("passkey");
    } finally {
      delete h.gotrue.impl.passkeyAuthVerify;
    }
  });

  it("a non-UV assertion is refused before GoTrue and writes no audit row", async () => {
    const before = h.gotrue.calls.passkeyAuthVerify.length;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/passkey/verify",
      headers: WEB,
      payload: { challengeId: CH_ID, credential: assertionCredential({ flags: FLAGS_UP_ONLY }) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("passkey_failed");
    expect(h.gotrue.calls.passkeyAuthVerify).toHaveLength(before);
  });

  it("register: 201, audit auth.passkey_added { passkey_id } under the user's claims, Q7 email captured", async () => {
    const u = await h.user();
    h.mailer.clear();
    const res = await h.inject(u, "POST", "/me/passkeys", {
      challengeId: CH_ID,
      credential: registrationCredential(),
      name: "Mom's iPhone",
    });
    expect(res.statusCode).toBe(201);
    expect(passkeySchema.parse(res.json()).name).toBe("Mom's iPhone");
    const added = await h.audit({ event: "auth.passkey_added", actor: u.id });
    expect(added).toHaveLength(1);
    expect(added[0]?.metadata).toEqual({ passkey_id: PK_ID, client: "web" });
    const mail = h.mailer.sent.find((m) => m.template === "passkey_added");
    expect(mail?.to).toBe(u.email);
    expect(mail?.html).not.toContain("<a ");
    expect(mail?.text).not.toContain("Mom's iPhone");
    // the audit table never holds the name either
    const { rows } = await h.admin.query(
      "SELECT metadata::text AS m FROM public.audit_log WHERE actor_user_id = $1",
      [u.id],
    );
    expect(rows.map((r) => (r as { m: string }).m).join("\n")).not.toContain("iPhone");
  });

  it("remove: 403 fresh_sign_in_required for an 11-minute-old session (no GoTrue call); 204 + audit + email when fresh", async () => {
    const stale = await h.user({ sessionAgeMin: 11 });
    const before = h.gotrue.calls.passkeyDelete.length;
    const refused = await h.inject(stale, "DELETE", `/me/passkeys/${PK_ID}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("fresh_sign_in_required");
    expect(h.gotrue.calls.passkeyDelete).toHaveLength(before);
    expect(await h.audit({ event: "auth.passkey_removed", actor: stale.id })).toHaveLength(0);

    const fresh = await h.user({ sessionAgeMin: 2 });
    h.mailer.clear();
    const ok = await h.inject(fresh, "DELETE", `/me/passkeys/${PK_ID}`);
    expect(ok.statusCode).toBe(204);
    expect(h.gotrue.calls.passkeyDelete.at(-1)).toEqual([fresh.token, PK_ID]);
    const removed = await h.audit({ event: "auth.passkey_removed", actor: fresh.id });
    expect(removed).toHaveLength(1);
    expect(removed[0]?.metadata).toMatchObject({ passkey_id: PK_ID });
    expect(h.mailer.sent.find((m) => m.template === "passkey_removed")?.to).toBe(fresh.email);
  });

  it("a revoked session cannot manage passkeys (401 session_revoked, no GoTrue call)", async () => {
    const u = await h.user();
    await h.admin.query("DELETE FROM auth.sessions WHERE id = $1", [u.sessionId]);
    const before = h.gotrue.calls.passkeyList.length;
    const res = await h.inject(u, "GET", "/me/passkeys");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("session_revoked");
    expect(h.gotrue.calls.passkeyList).toHaveLength(before);
  });

  it("a user without consent cannot manage passkeys (403 consent_required)", async () => {
    const u = await h.user({ consent: false });
    const res = await h.inject(u, "POST", "/me/passkeys/options");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("consent_required");
  });
});
