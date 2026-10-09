import { createHash } from "node:crypto";
import {
  apiErrorSchema,
  type ReindexJob,
  type ShareApplyJob,
  shareLinkCreatedResponseSchema,
  shareLinkPhotosAddResponseSchema,
  shareLinkPhotosResponseSchema,
  shareLinkSchema,
  shareLinksResponseSchema,
  shareRuleSchema,
} from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "../app";
import type { JobQueue } from "../plugins/jobs";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";
import { testConfig } from "../testing/support";
import { verifyPasscode } from "./crypto";

// Admin share-link routes against a real database (docs/plans/step-8.md 2.5, 2.12; PRD FR-9.1-9.8,
// "Roles and permissions": only a baby's admins create, renew and revoke links; "Auth security
// requirements": link events are audited without secrets). RLS is the backstop: a stranger sees
// 404 on every route, a contributor 403.

const PASSCODE = "739104";
const NAME = "SENTINEL-LINK-NAME-Grandparents";

describe.skipIf(!databaseUrl)("admin share-link routes (api + db)", () => {
  let h: Harness;
  let mom: TestUser;
  let dad: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let plusBaby: string;
  let freeBaby: string;
  let otherBaby: string;
  const applied: ShareApplyJob[] = [];
  const reindexed: ReindexJob[] = [];
  const logLines: string[] = [];
  const jobs: JobQueue = {
    enqueueIngest: async () => true,
    async enqueueReindex(job) {
      reindexed.push(job);
      return true;
    },
    async enqueueShareApply(job) {
      applied.push(job);
      return true;
    },
    close: async () => undefined,
  };
  const ph: Record<string, string> = {};

  const post = (u: TestUser | null, url: string, body: unknown = {}) =>
    h.inject(u, "POST", url, body);
  const tokenOf = (url: string) => url.split("/s/")[1] as string;

  async function createLink(
    u: TestUser,
    babyId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; url: string; token: string }> {
    // Keep each baby under the 20-link cap whatever the number of tests (oldest links go first).
    await h.admin.query(
      `DELETE FROM public.share_links WHERE id IN (
         SELECT id FROM public.share_links WHERE baby_id = $1 ORDER BY created_at DESC, id DESC
         OFFSET 15)`,
      [babyId],
    );
    const res = await post(u, `/babies/${babyId}/share-links`, { name: NAME, ...body });
    expect(res.statusCode, res.body).toBe(201);
    const parsed = shareLinkCreatedResponseSchema.parse(res.json());
    return { id: parsed.link.id, url: parsed.url, token: tokenOf(parsed.url) };
  }
  const row = async (id: string) =>
    (
      await h.admin.query(
        `SELECT token_hash, passcode_hash, expires_at, revoked_at, ttl_hours, allow_download, name,
                token_rotated_at, view_count
           FROM public.share_links WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const albumIds = async (linkId: string, by?: string) =>
    (
      await h.admin.query<{ photo_id: string }>(
        `SELECT photo_id FROM public.shared_photos WHERE share_link_id = $1 ${by ? "AND added_by = $2" : ""} ORDER BY photo_id`,
        by ? [linkId, by] : [linkId],
      )
    ).rows.map((r) => r.photo_id);
  const linkAudit = async (event: string, linkId: string) =>
    (
      await h.admin.query(
        "SELECT metadata, actor_user_id, baby_id FROM public.audit_log WHERE event = $1 AND share_link_id = $2 ORDER BY id",
        [event, linkId],
      )
    ).rows as {
      metadata: Record<string, unknown>;
      actor_user_id: string | null;
      baby_id: string;
    }[];

  beforeAll(async () => {
    h = await createHarness({
      jobs,
      logger: {
        ...loggerOptions(testConfig()),
        level: "info",
        stream: { write: (s: string) => void logLines.push(s) },
      },
    });
    mom = await h.user();
    dad = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    plusBaby = await h.baby(mom, "Plus baby");
    freeBaby = await h.baby(mom, "Free baby");
    otherBaby = await h.baby(stranger, "Other baby");
    await h.member(plusBaby, dad, "admin");
    await h.member(plusBaby, nanny, "contributor");
    await h.member(freeBaby, nanny, "contributor");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [plusBaby]);

    const mk = (key: string, babyId: string, o: Parameters<typeof seedPhoto>[2] = {}) =>
      seedPhoto(h.admin, babyId, {
        uploadedBy: mom.id,
        withThumb: true,
        withDisplay: true,
        ...o,
      }).then((id) => {
        ph[key] = id;
      });
    await mk("a", plusBaby, { takenAt: "2026-06-10T10:00:00Z" });
    await mk("b", plusBaby, { takenAt: "2026-06-11T10:00:00Z" });
    await mk("c", plusBaby, { takenAt: "2026-06-12T10:00:00Z" });
    await mk("sens", plusBaby, { takenAt: "2026-06-13T10:00:00Z" });
    await mk("pending", plusBaby, { approval: "pending" });
    await mk("trashed", plusBaby, { trashedAgo: "1 hour" });
    await mk("quarantined", plusBaby, { quarantined: true });
    await mk("failed", plusBaby, { status: "failed" });
    await mk("free1", freeBaby);
    await mk("other", otherBaby);
    await h.admin.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [ph.sens]);
  });
  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  describe("who may call", () => {
    it("401 for everything without credentials", async () => {
      const { id } = await createLink(mom, plusBaby);
      const calls: Array<[string, string, unknown?]> = [
        ["GET", `/babies/${plusBaby}/share-links`],
        ["POST", `/babies/${plusBaby}/share-links`, { name: "x" }],
        ["PATCH", `/share-links/${id}`, { name: "y" }],
        ["POST", `/share-links/${id}/renew`, {}],
        ["POST", `/share-links/${id}/regenerate`, {}],
        ["POST", `/share-links/${id}/revoke`, {}],
        ["DELETE", `/share-links/${id}`],
        ["PUT", `/share-links/${id}/rule`, { mode: "all" }],
        ["DELETE", `/share-links/${id}/rule`],
        ["GET", `/share-links/${id}/photos`],
        ["POST", `/share-links/${id}/photos`, { photoIds: [ph.a] }],
        ["POST", `/share-links/${id}/photos/remove`, { photoIds: [ph.a] }],
        ["PATCH", `/share-links/${id}/photos/${ph.a}`, { showSensitive: true }],
        ["GET", `/photos/${ph.a}/share-links`],
      ];
      for (const [method, url, body] of calls) {
        const res = await h.inject(null, method as "GET", url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it("a stranger gets 404 on every route, and nothing changes", async () => {
      const { id } = await createLink(mom, plusBaby, { passcode: PASSCODE });
      const before = await row(id);
      const calls: Array<[string, string, unknown?]> = [
        ["GET", `/babies/${plusBaby}/share-links`],
        ["POST", `/babies/${plusBaby}/share-links`, { name: "x" }],
        ["PATCH", `/share-links/${id}`, { name: "y" }],
        ["POST", `/share-links/${id}/renew`, {}],
        ["POST", `/share-links/${id}/regenerate`, {}],
        ["POST", `/share-links/${id}/revoke`, {}],
        ["DELETE", `/share-links/${id}`],
        ["PUT", `/share-links/${id}/rule`, { mode: "all" }],
        ["DELETE", `/share-links/${id}/rule`],
        ["GET", `/share-links/${id}/photos`],
        ["POST", `/share-links/${id}/photos`, { photoIds: [ph.a] }],
        ["POST", `/share-links/${id}/photos/remove`, { photoIds: [ph.a] }],
        ["PATCH", `/share-links/${id}/photos/${ph.a}`, { showSensitive: true }],
        ["GET", `/photos/${ph.a}/share-links`],
      ];
      for (const [method, url, body] of calls) {
        const res = await h.inject(stranger, method as "GET", url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(apiErrorSchema.parse(res.json()).error).toBe("not_found");
      }
      const after = await row(id);
      expect(after.token_hash.equals(before.token_hash)).toBe(true);
      expect(after.name).toBe(before.name);
      expect(after.revoked_at).toBeNull();
    });

    it("a stranger's own baby does not unlock another baby's link (id of a foreign link is 404)", async () => {
      const { id } = await createLink(mom, plusBaby);
      const res = await h.inject(stranger, "POST", `/share-links/${id}/revoke`, {});
      expect(res.statusCode).toBe(404);
      expect((await row(id)).revoked_at).toBeNull();
      // an unknown id is the same 404
      const unknown = await h.inject(
        stranger,
        "POST",
        "/share-links/00000000-0000-4000-8000-00000000dead/revoke",
        {},
      );
      expect(unknown.statusCode).toBe(404);
    });

    it("a contributor (the nanny) gets 403 on every route, and nothing changes", async () => {
      const { id } = await createLink(mom, plusBaby);
      const before = await row(id);
      const calls: Array<[string, string, unknown?]> = [
        ["GET", `/babies/${plusBaby}/share-links`],
        ["POST", `/babies/${plusBaby}/share-links`, { name: "x" }],
        ["PATCH", `/share-links/${id}`, { name: "y" }],
        ["POST", `/share-links/${id}/renew`, {}],
        ["POST", `/share-links/${id}/regenerate`, {}],
        ["POST", `/share-links/${id}/revoke`, {}],
        ["DELETE", `/share-links/${id}`],
        ["PUT", `/share-links/${id}/rule`, { mode: "all" }],
        ["DELETE", `/share-links/${id}/rule`],
        ["GET", `/share-links/${id}/photos`],
        ["POST", `/share-links/${id}/photos`, { photoIds: [ph.a] }],
        ["POST", `/share-links/${id}/photos/remove`, { photoIds: [ph.a] }],
        ["PATCH", `/share-links/${id}/photos/${ph.a}`, { showSensitive: true }],
        ["GET", `/photos/${ph.a}/share-links`],
      ];
      for (const [method, url, body] of calls) {
        const res = await h.inject(nanny, method as "GET", url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(apiErrorSchema.parse(res.json()).error).toBe("forbidden");
      }
      const after = await row(id);
      expect(after.token_hash.equals(before.token_hash)).toBe(true);
      expect(after.revoked_at).toBeNull();
      expect(await albumIds(id)).toEqual([]);
    });

    it("a second admin (dad) can manage the mom's link", async () => {
      const { id } = await createLink(mom, plusBaby);
      const res = await h.inject(dad, "PATCH", `/share-links/${id}`, { name: "Renamed by dad" });
      expect(res.statusCode, res.body).toBe(200);
      expect(shareLinkSchema.parse(res.json()).name).toBe("Renamed by dad");
    });

    it("a user without accepted consent is refused", async () => {
      const fresh = await h.user({ consent: false });
      const res = await h.inject(fresh, "GET", `/babies/${plusBaby}/share-links`);
      expect([403, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("create, list, settings", () => {
    it("create returns the URL once: PUBLIC_URL/s/<22-char token>; the list never carries it", async () => {
      const res = await post(mom, `/babies/${plusBaby}/share-links`, { name: NAME });
      expect(res.statusCode).toBe(201);
      const created = shareLinkCreatedResponseSchema.parse(res.json());
      expect(created.url).toMatch(/^http:\/\/localhost:8080\/s\/[A-Za-z0-9_-]{22}$/);
      const token = tokenOf(created.url);

      // stored: only the SHA-256, never the plaintext token, anywhere in the row
      const r = await row(created.link.id);
      expect(r.token_hash.equals(createHash("sha256").update(token).digest())).toBe(true);
      const dump = await h.admin.query(
        "SELECT row_to_json(l)::text AS j FROM public.share_links l WHERE id = $1",
        [created.link.id],
      );
      expect(dump.rows[0].j).not.toContain(token);

      // every other response of this link is token-free
      const list = await h.inject(mom, "GET", `/babies/${plusBaby}/share-links`);
      expect(list.statusCode).toBe(200);
      const links = shareLinksResponseSchema.parse(list.json()).links;
      expect(links.find((l) => l.id === created.link.id)).toBeTruthy();
      expect(list.body).not.toContain(token);
      expect(list.body).not.toMatch(/token|"url"/i);
      const one = await h.inject(mom, "PATCH", `/share-links/${created.link.id}`, { name: "n2" });
      expect(one.body).not.toContain(token);
    });

    it("defaults: expiry is now + 24 h, ttlHours 24, no download, no passcode, active, newest first", async () => {
      const a = await createLink(mom, plusBaby);
      const res = await h.inject(mom, "GET", `/babies/${plusBaby}/share-links`);
      const links = shareLinksResponseSchema.parse(res.json()).links;
      const link = links.find((l) => l.id === a.id);
      expect(link).toMatchObject({
        status: "active",
        ttlHours: 24,
        allowDownload: false,
        hasPasscode: false,
        passcodeLocked: false,
        rule: null,
        photoCount: 0,
        hiddenCount: 0,
        viewCount: 0,
        lastViewedAt: null,
        activeViewers: 0,
        revokedAt: null,
      });
      const ms = Date.parse(link?.expiresAt ?? "") - Date.now();
      expect(Math.abs(ms - 24 * 3600_000)).toBeLessThan(2 * 60_000);
      const times = links.map((l) => Date.parse(l.createdAt));
      expect(times).toEqual([...times].sort((x, y) => y - x));
    });

    it("the maximum is 720 h; 0, 721, fractions and a missing name are 400", async () => {
      const ok = await post(mom, `/babies/${plusBaby}/share-links`, { name: "Max", ttlHours: 720 });
      expect(ok.statusCode).toBe(201);
      const created = shareLinkCreatedResponseSchema.parse(ok.json());
      const ms = Date.parse(created.link.expiresAt) - Date.now();
      expect(Math.abs(ms - 720 * 3600_000)).toBeLessThan(2 * 60_000);
      for (const bad of [
        { name: "x", ttlHours: 721 },
        { name: "x", ttlHours: 0 },
        { name: "x", ttlHours: 1.5 },
        { name: "x", ttlHours: -1 },
        { ttlHours: 24 },
        { name: "   " },
        { name: "x".repeat(81) },
        { name: "x", passcode: "12345" },
        { name: "x", passcode: "abcdef" },
        { name: "x", unknownKey: true },
        { name: "x", rule: { mode: "tags" } },
      ]) {
        const res = await post(mom, `/babies/${plusBaby}/share-links`, bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
        expect(apiErrorSchema.parse(res.json()).error).toBe("validation_failed");
      }
    });

    it("a passcode is stored as scrypt and verifies; the response only says hasPasscode", async () => {
      const { id, token } = await createLink(mom, plusBaby, {
        passcode: PASSCODE,
        allowDownload: true,
      });
      const r = await row(id);
      expect(r.passcode_hash).toMatch(/^scrypt\$1\$16384\$8\$1\$/);
      expect(r.passcode_hash).not.toContain(PASSCODE);
      expect(await verifyPasscode(PASSCODE, r.passcode_hash)).toBe(true);
      expect(r.allow_download).toBe(true);
      const list = await h.inject(mom, "GET", `/babies/${plusBaby}/share-links`);
      const link = shareLinksResponseSchema.parse(list.json()).links.find((l) => l.id === id);
      expect(link).toMatchObject({ hasPasscode: true, allowDownload: true });
      expect(list.body).not.toContain(PASSCODE);
      expect(list.body).not.toContain(token);
      expect(list.body).not.toContain("scrypt");
    });

    it("at most 20 links per baby: the 21st is 409 conflict", async () => {
      const babyId = await h.baby(mom, "Cap baby");
      for (let i = 0; i < 20; i++) {
        const ok = await post(mom, `/babies/${babyId}/share-links`, { name: `L${i}` });
        expect(ok.statusCode, ok.body).toBe(201);
      }
      const res = await post(mom, `/babies/${babyId}/share-links`, { name: "one too many" });
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("conflict");
      const { rows } = await h.admin.query(
        "SELECT count(*)::int n FROM public.share_links WHERE baby_id = $1",
        [babyId],
      );
      expect(rows[0].n).toBe(20);
    });

    it("PATCH name / download / passcode set and clear / ttlHours; an empty or unknown body is 400", async () => {
      const { id } = await createLink(mom, plusBaby);
      const patch = (body: unknown) => h.inject(mom, "PATCH", `/share-links/${id}`, body);
      expect((await patch({ name: "  Close friends " })).json().name).toBe("Close friends");
      expect((await patch({ allowDownload: true })).json().allowDownload).toBe(true);
      expect((await patch({ passcode: PASSCODE })).json().hasPasscode).toBe(true);
      expect((await row(id)).passcode_hash).toMatch(/^scrypt\$/);
      expect((await patch({ passcode: null })).json().hasPasscode).toBe(false);
      expect((await row(id)).passcode_hash).toBeNull();
      expect((await patch({ ttlHours: 72 })).json().ttlHours).toBe(72);
      for (const bad of [
        {},
        { passcode: "1234" },
        { ttlHours: 721 },
        { expiresAt: "2030-01-01" },
        { name: "" },
      ]) {
        expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      // audit: which fields changed, never values
      const events = await linkAudit("share_link.updated", id);
      expect(events.map((e) => e.metadata.fields)).toEqual([
        ["name"],
        ["allow_download"],
        ["passcode"],
        ["passcode"],
        ["ttl_hours"],
      ]);
      expect(JSON.stringify(events)).not.toContain(PASSCODE);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("renew, regenerate, revoke, delete", () => {
    it("renew keeps the token and moves expiry to now + ttl; ttlHours overrides and is remembered", async () => {
      const { id } = await createLink(mom, plusBaby, { ttlHours: 24 });
      const hashBefore = (await row(id)).token_hash;
      await h.admin.query(
        "UPDATE public.share_links SET expires_at = now() - interval '2 hours' WHERE id = $1",
        [id],
      );
      const status = async () => {
        const l = shareLinksResponseSchema
          .parse((await h.inject(mom, "GET", `/babies/${plusBaby}/share-links`)).json())
          .links.find((x) => x.id === id);
        return l?.status;
      };
      expect(await status()).toBe("expired");
      const res = await post(mom, `/share-links/${id}/renew`, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(shareLinkSchema.parse(res.json()).status).toBe("active");
      const r = await row(id);
      expect(r.token_hash.equals(hashBefore)).toBe(true);
      expect(Math.abs(r.expires_at.getTime() - Date.now() - 24 * 3600_000)).toBeLessThan(
        2 * 60_000,
      );

      const again = await post(mom, `/share-links/${id}/renew`, { ttlHours: 168 });
      expect(again.statusCode).toBe(200);
      const r2 = await row(id);
      expect(r2.ttl_hours).toBe(168);
      expect(Math.abs(r2.expires_at.getTime() - Date.now() - 168 * 3600_000)).toBeLessThan(
        2 * 60_000,
      );
      expect((await post(mom, `/share-links/${id}/renew`, { ttlHours: 721 })).statusCode).toBe(400);
      expect((await linkAudit("share_link.renewed", id)).map((e) => e.metadata)).toEqual([
        { hours: 24 },
        { hours: 168 },
      ]);
    });

    it("renewing a revoked link is 409 conflict and changes nothing", async () => {
      const { id } = await createLink(mom, plusBaby);
      expect((await post(mom, `/share-links/${id}/revoke`)).statusCode).toBe(200);
      const before = await row(id);
      const res = await post(mom, `/share-links/${id}/renew`, {});
      expect(res.statusCode).toBe(409);
      const err = apiErrorSchema.parse(res.json());
      expect(err.error).toBe("conflict");
      expect(err.message).toBe("This link was revoked. Regenerate it to share again.");
      const after = await row(id);
      expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
      expect(after.revoked_at).not.toBeNull();
      expect(await linkAudit("share_link.renewed", id)).toHaveLength(0);
    });

    it("regenerate: a new token (old hash gone), un-revokes, resets expiry, keeps the passcode, URL once", async () => {
      const { id, token } = await createLink(mom, plusBaby, { passcode: PASSCODE, ttlHours: 72 });
      await post(mom, `/share-links/${id}/revoke`);
      const before = await row(id);
      expect(before.revoked_at).not.toBeNull();
      const res = await post(mom, `/share-links/${id}/regenerate`);
      expect(res.statusCode, res.body).toBe(200);
      const regenerated = shareLinkCreatedResponseSchema.parse(res.json());
      const next = tokenOf(regenerated.url);
      expect(next).not.toBe(token);
      expect(regenerated.link).toMatchObject({ status: "active", hasPasscode: true });
      const after = await row(id);
      expect(after.token_hash.equals(createHash("sha256").update(next).digest())).toBe(true);
      expect(after.token_hash.equals(before.token_hash)).toBe(false);
      expect(after.revoked_at).toBeNull();
      expect(after.token_rotated_at).not.toBeNull();
      expect(after.passcode_hash).toBe(before.passcode_hash);
      expect(Math.abs(after.expires_at.getTime() - Date.now() - 72 * 3600_000)).toBeLessThan(
        2 * 60_000,
      );
      expect(await linkAudit("share_link.regenerated", id)).toHaveLength(1);
    });

    it("revoke is idempotent: a second call is 200, unchanged, with no second audit row", async () => {
      const { id } = await createLink(mom, plusBaby);
      const first = await post(mom, `/share-links/${id}/revoke`);
      expect(first.statusCode).toBe(200);
      expect(shareLinkSchema.parse(first.json())).toMatchObject({ status: "revoked" });
      const stamp = (await row(id)).revoked_at.getTime();
      const second = await post(mom, `/share-links/${id}/revoke`);
      expect(second.statusCode).toBe(200);
      expect((await row(id)).revoked_at.getTime()).toBe(stamp);
      expect(await linkAudit("share_link.revoked", id)).toHaveLength(1);
    });

    it("delete removes the link, its rule and album rows; the audit row survives with a NULL link id", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.a] });
      await h.inject(mom, "PUT", `/share-links/${id}/rule`, { mode: "all" });
      const res = await h.inject(mom, "DELETE", `/share-links/${id}`);
      expect(res.statusCode).toBe(204);
      for (const table of ["share_links", "shared_photos", "share_rules"]) {
        const col = table === "share_links" ? "id" : "share_link_id";
        const { rows } = await h.admin.query(
          `SELECT count(*)::int n FROM public.${table} WHERE ${col} = $1`,
          [id],
        );
        expect(rows[0].n, table).toBe(0);
      }
      expect((await h.inject(mom, "DELETE", `/share-links/${id}`)).statusCode).toBe(404);
      const { rows } = await h.admin.query(
        "SELECT count(*)::int n FROM public.audit_log WHERE event = 'share_link.deleted' AND baby_id = $1 AND share_link_id IS NULL",
        [plusBaby],
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("a trashed baby can be listed and revoked but not given new links or renewals", async () => {
      const babyId = await h.baby(mom, "Soon trashed");
      const { id } = await createLink(mom, babyId);
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [babyId]);
      expect((await h.inject(mom, "GET", `/babies/${babyId}/share-links`)).statusCode).toBe(200);
      expect((await post(mom, `/babies/${babyId}/share-links`, { name: "x" })).statusCode).toBe(
        409,
      );
      expect((await post(mom, `/share-links/${id}/renew`, {})).statusCode).toBe(409);
      expect((await post(mom, `/share-links/${id}/revoke`)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("auto-share rules (Plus only)", () => {
    it("a free baby: PUT rule is 403 plan_required, nothing is stored, nothing is enqueued", async () => {
      const { id } = await createLink(mom, freeBaby);
      applied.length = 0;
      const res = await h.inject(mom, "PUT", `/share-links/${id}/rule`, { mode: "all" });
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("plan_required");
      const { rows } = await h.admin.query(
        "SELECT count(*)::int n FROM public.share_rules WHERE share_link_id = $1",
        [id],
      );
      expect(rows[0].n).toBe(0);
      expect(applied).toEqual([]);
    });

    it("a free baby: create-with-rule is 403 plan_required and creates no link at all", async () => {
      const { rows: before } = await h.admin.query(
        "SELECT count(*)::int n FROM public.share_links WHERE baby_id = $1",
        [freeBaby],
      );
      applied.length = 0;
      const res = await post(mom, `/babies/${freeBaby}/share-links`, {
        name: "x",
        rule: { mode: "all" },
      });
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("plan_required");
      const { rows: after } = await h.admin.query(
        "SELECT count(*)::int n FROM public.share_links WHERE baby_id = $1",
        [freeBaby],
      );
      expect(after[0].n).toBe(before[0].n);
      expect(applied).toEqual([]);
    });

    it("a plus baby: PUT stores a normalized rule, audits the mode, and enqueues share.apply after commit", async () => {
      const { id } = await createLink(mom, plusBaby);
      applied.length = 0;
      const res = await h.inject(mom, "PUT", `/share-links/${id}/rule`, {
        mode: "tags",
        includeTags: [" Outdoor ", "PLAY   time", "outdoor"],
        excludeTags: ["BATH"],
      });
      expect(res.statusCode, res.body).toBe(200);
      const rule = shareRuleSchema.parse(res.json());
      expect(rule).toMatchObject({
        mode: "tags",
        includeTags: ["outdoor", "play time"],
        excludeTags: ["bath"],
        evaluatedAt: null,
      });
      expect(applied).toEqual([{ shareLinkId: id, reason: "rule_changed" }]);
      expect((await linkAudit("share_link.rule_updated", id)).map((e) => e.metadata)).toEqual([
        { mode: "tags" },
      ]);
      // the link now shows the rule
      const list = shareLinksResponseSchema.parse(
        (await h.inject(mom, "GET", `/babies/${plusBaby}/share-links`)).json(),
      );
      expect(list.links.find((l) => l.id === id)?.rule).toMatchObject({ mode: "tags" });
      // an update replaces it
      const again = await h.inject(mom, "PUT", `/share-links/${id}/rule`, { mode: "milestones" });
      expect(shareRuleSchema.parse(again.json())).toMatchObject({
        mode: "milestones",
        includeTags: [],
      });
      expect(applied).toHaveLength(2);
    });

    it("create-with-rule on a plus baby stores the rule and enqueues once", async () => {
      applied.length = 0;
      const { id } = await createLink(mom, plusBaby, { rule: { mode: "all" } });
      expect(applied).toEqual([{ shareLinkId: id, reason: "rule_changed" }]);
      const { rows } = await h.admin.query(
        "SELECT mode FROM public.share_rules WHERE share_link_id = $1",
        [id],
      );
      expect(rows[0].mode).toBe("all");
      expect((await linkAudit("share_link.created", id))[0]?.metadata).toMatchObject({
        mode: "all",
      });
    });

    it("invalid rules are 400: tags mode without include tags, more than 20 tags, over-long tags, unknown keys", async () => {
      const { id } = await createLink(mom, plusBaby);
      applied.length = 0;
      for (const bad of [
        { mode: "tags" },
        { mode: "tags", includeTags: [] },
        { mode: "all", includeTags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
        { mode: "all", excludeTags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
        { mode: "all", excludeTags: ["x".repeat(61)] },
        { mode: "all", excludeTags: [""] },
        { mode: "nope" },
        { mode: "all", extra: 1 },
      ]) {
        const res = await h.inject(mom, "PUT", `/share-links/${id}/rule`, bad);
        expect(res.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400);
        expect(apiErrorSchema.parse(res.json()).error).toBe("validation_failed");
      }
      expect(applied).toEqual([]);
    });

    it("DELETE rule leaves the photos it added, is idempotent, and is allowed after a downgrade", async () => {
      const babyId = await h.baby(mom, "Downgrader");
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [babyId]);
      const p = await seedPhoto(h.admin, babyId, { uploadedBy: mom.id, withThumb: true });
      const { id } = await createLink(mom, babyId, { rule: { mode: "all" } });
      // as if the worker had added the photo: a rule row needs an analysed photo
      await h.admin.query(
        `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
         VALUES ($1, 'fake', 'v1', 'v1', '{}'::jsonb)`,
        [p],
      );
      await h.admin.query(
        "INSERT INTO public.shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')",
        [id, p],
      );
      await h.admin.query("UPDATE public.babies SET plan = 'free' WHERE id = $1", [babyId]);
      expect((await h.inject(mom, "DELETE", `/share-links/${id}/rule`)).statusCode).toBe(204);
      expect(await albumIds(id)).toEqual([p]);
      expect((await h.inject(mom, "DELETE", `/share-links/${id}/rule`)).statusCode).toBe(204);
      expect(await linkAudit("share_link.rule_removed", id)).toHaveLength(1);
      // a downgraded baby can no longer set one
      expect(
        (await h.inject(mom, "PUT", `/share-links/${id}/rule`, { mode: "all" })).statusCode,
      ).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("album membership", () => {
    it("adds eligible photos and reports skipped ones by reason; sensitive photos are added hidden", async () => {
      const { id } = await createLink(mom, plusBaby);
      const res = await post(mom, `/share-links/${id}/photos`, {
        photoIds: [
          ph.a,
          ph.b,
          ph.sens,
          ph.pending,
          ph.trashed,
          ph.quarantined,
          ph.failed,
          ph.other,
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      const out = shareLinkPhotosAddResponseSchema.parse(res.json());
      expect(out).toMatchObject({ added: 3, alreadyShared: 0, hidden: 1 });
      const reasons = Object.fromEntries(out.skipped.map((s) => [s.photoId, s.reason]));
      expect(reasons).toEqual({
        [ph.pending as string]: "not_approved",
        [ph.trashed as string]: "trashed",
        [ph.quarantined as string]: "not_found",
        [ph.failed as string]: "not_found",
        [ph.other as string]: "not_found",
      });
      expect(await albumIds(id)).toEqual([ph.a, ph.b, ph.sens].sort() as string[]);
      expect(await albumIds(id, "rule")).toEqual([]);
      const { rows } = await h.admin.query(
        "SELECT sensitive_released_at FROM public.shared_photos WHERE share_link_id = $1 AND photo_id = $2",
        [id, ph.sens],
      );
      expect(rows[0].sensitive_released_at).toBeNull();
      const photos = await h.inject(mom, "GET", `/share-links/${id}/photos`);
      const listed = shareLinkPhotosResponseSchema.parse(photos.json());
      expect(listed.photos).toHaveLength(3);
      const sens = listed.photos.find((p) => p.id === ph.sens);
      expect(sens).toMatchObject({ sharedBy: "user", hiddenFromViewers: true });
      expect(listed.photos.filter((p) => p.hiddenFromViewers)).toHaveLength(1);
      const link = shareLinksResponseSchema
        .parse((await h.inject(mom, "GET", `/babies/${plusBaby}/share-links`)).json())
        .links.find((l) => l.id === id);
      expect(link).toMatchObject({ photoCount: 3, hiddenCount: 1 });
      expect((await linkAudit("share_link.photos_added", id))[0]?.metadata).toEqual({ count: 3 });
    });

    it("adding again counts alreadyShared; showSensitive releases the sensitive photo and audits it", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.a, ph.sens] });
      const res = await post(mom, `/share-links/${id}/photos`, {
        photoIds: [ph.a, ph.sens, ph.c],
        showSensitive: true,
      });
      const out = shareLinkPhotosAddResponseSchema.parse(res.json());
      expect(out).toMatchObject({ added: 1, alreadyShared: 2, hidden: 0 });
      const { rows } = await h.admin.query(
        "SELECT sensitive_released_at, sensitive_released_by FROM public.shared_photos WHERE share_link_id = $1 AND photo_id = $2",
        [id, ph.sens],
      );
      expect(rows[0].sensitive_released_at).not.toBeNull();
      expect(rows[0].sensitive_released_by).toBe(mom.id);
      expect((await linkAudit("share_link.sensitive_shown", id)).map((e) => e.metadata)).toEqual([
        { photo_id: ph.sens },
      ]);
    });

    it("showSensitive on a photo that is not sensitive records no release", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.a], showSensitive: true });
      const { rows } = await h.admin.query(
        "SELECT sensitive_released_at FROM public.shared_photos WHERE share_link_id = $1",
        [id],
      );
      expect(rows[0].sensitive_released_at).toBeNull();
      expect(await linkAudit("share_link.sensitive_shown", id)).toHaveLength(0);
    });

    it("PATCH showSensitive shows and hides one photo; a photo not in the album is 404", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.sens] });
      const show = await h.inject(mom, "PATCH", `/share-links/${id}/photos/${ph.sens}`, {
        showSensitive: true,
      });
      expect(show.statusCode, show.body).toBe(200);
      expect(show.json().hiddenFromViewers).toBe(false);
      const hide = await h.inject(mom, "PATCH", `/share-links/${id}/photos/${ph.sens}`, {
        showSensitive: false,
      });
      expect(hide.json().hiddenFromViewers).toBe(true);
      expect(await linkAudit("share_link.sensitive_shown", id)).toHaveLength(1);
      expect(await linkAudit("share_link.sensitive_hidden", id)).toHaveLength(1);
      const missing = await h.inject(mom, "PATCH", `/share-links/${id}/photos/${ph.a}`, {
        showSensitive: true,
      });
      expect(missing.statusCode).toBe(404);
      expect(
        (await h.inject(mom, "PATCH", `/share-links/${id}/photos/${ph.sens}`, { show: true }))
          .statusCode,
      ).toBe(400);
    });

    it("works on a free baby (sharing is free)", async () => {
      const { id } = await createLink(mom, freeBaby);
      const res = await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.free1] });
      expect(res.statusCode).toBe(200);
      expect(shareLinkPhotosAddResponseSchema.parse(res.json()).added).toBe(1);
    });

    it("remove deletes the row and remembers the removal; adding by hand lifts it", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.a, ph.b] });
      const res = await post(mom, `/share-links/${id}/photos/remove`, {
        photoIds: [ph.a, ph.c, ph.other],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ removed: 1 });
      expect(await albumIds(id)).toEqual([ph.b]);
      const { rows } = await h.admin.query(
        "SELECT photo_id FROM public.shared_photo_exclusions WHERE share_link_id = $1 ORDER BY photo_id",
        [id],
      );
      // exclusions for this baby's photos only (the foreign baby's photo is ignored)
      expect(rows.map((r) => r.photo_id).sort()).toEqual([ph.a, ph.c].sort());
      const links = await h.inject(mom, "GET", `/photos/${ph.a}/share-links`);
      expect(
        links.json().links.find((l: { shareLinkId: string }) => l.shareLinkId === id),
      ).toMatchObject({
        shared: false,
        excluded: true,
      });
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.a] });
      const after = await h.admin.query(
        "SELECT count(*)::int n FROM public.shared_photo_exclusions WHERE share_link_id = $1 AND photo_id = $2",
        [id, ph.a],
      );
      expect(after.rows[0].n).toBe(0);
      expect((await linkAudit("share_link.photos_removed", id))[0]?.metadata).toEqual({ count: 1 });
    });

    it("GET /photos/:id/share-links reflects shared state and hidden tiles per link", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.sens] });
      const res = await h.inject(mom, "GET", `/photos/${ph.sens}/share-links`);
      expect(res.statusCode).toBe(200);
      const mine = res.json().links.find((l: { shareLinkId: string }) => l.shareLinkId === id);
      expect(mine).toMatchObject({
        shared: true,
        sharedBy: "user",
        hiddenFromViewers: true,
        excluded: false,
      });
    });

    it("paging the album is newest first", async () => {
      const { id } = await createLink(mom, plusBaby);
      await post(mom, `/share-links/${id}/photos`, { photoIds: [ph.a, ph.b, ph.c] });
      const first = shareLinkPhotosResponseSchema.parse(
        (await h.inject(mom, "GET", `/share-links/${id}/photos?limit=2`)).json(),
      );
      expect(first.photos.map((p) => p.id)).toEqual([ph.c, ph.b]);
      expect(first.nextCursor).toBeTruthy();
      const second = shareLinkPhotosResponseSchema.parse(
        (
          await h.inject(
            mom,
            "GET",
            `/share-links/${id}/photos?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
          )
        ).json(),
      );
      expect(second.photos.map((p) => p.id)).toEqual([ph.a]);
      expect(second.nextCursor).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("privacy: audit rows and logs", () => {
    it("audit metadata holds only ids, counts and flags: never a token, passcode, hash or name", async () => {
      const { id, token } = await createLink(mom, plusBaby, {
        passcode: PASSCODE,
        rule: { mode: "all" },
      });
      await h.inject(mom, "PATCH", `/share-links/${id}`, { passcode: PASSCODE, name: NAME });
      await post(mom, `/share-links/${id}/photos`, {
        photoIds: [ph.a, ph.sens],
        showSensitive: true,
      });
      await post(mom, `/share-links/${id}/photos/remove`, { photoIds: [ph.a] });
      await post(mom, `/share-links/${id}/renew`, {});
      const regenerated = shareLinkCreatedResponseSchema.parse(
        (await post(mom, `/share-links/${id}/regenerate`)).json(),
      );
      await post(mom, `/share-links/${id}/revoke`);
      const { rows } = await h.admin.query(
        "SELECT event, metadata, actor_user_id FROM public.audit_log WHERE share_link_id = $1 ORDER BY id",
        [id],
      );
      expect(rows.map((r) => r.event)).toEqual(
        expect.arrayContaining([
          "share_link.created",
          "share_link.updated",
          "share_link.photos_added",
          "share_link.sensitive_shown",
          "share_link.photos_removed",
          "share_link.renewed",
          "share_link.regenerated",
          "share_link.revoked",
        ]),
      );
      const allowed = new Set([
        "hours",
        "has_passcode",
        "allow_download",
        "mode",
        "fields",
        "count",
        "photo_id",
      ]);
      for (const r of rows) {
        expect(r.actor_user_id).toBe(mom.id);
        for (const [k, v] of Object.entries(r.metadata as Record<string, unknown>)) {
          expect(allowed.has(k), `${r.event}.${k}`).toBe(true);
          expect(["number", "boolean", "string", "object"]).toContain(typeof v);
        }
      }
      const text = JSON.stringify(rows);
      for (const secret of [
        token,
        tokenOf(regenerated.url),
        PASSCODE,
        NAME,
        "scrypt",
        "Plus baby",
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it("the API log never contains a token, URL, passcode, hash or link name", async () => {
      logLines.length = 0;
      const { id, token, url } = await createLink(mom, plusBaby, { passcode: PASSCODE });
      await h.inject(mom, "PATCH", `/share-links/${id}`, { passcode: "246810" });
      const regenerated = shareLinkCreatedResponseSchema.parse(
        (await post(mom, `/share-links/${id}/regenerate`)).json(),
      );
      await post(mom, `/share-links/${id}/revoke`);
      const text = logLines.join("\n");
      expect(text.length).toBeGreaterThan(0);
      for (const secret of [
        token,
        url,
        regenerated.url,
        tokenOf(regenerated.url),
        PASSCODE,
        "246810",
        NAME,
        "scrypt$",
      ]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toMatch(/X-Amz-Signature/i);
    });
  });
});
