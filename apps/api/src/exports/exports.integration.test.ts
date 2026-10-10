import {
  apiErrorSchema,
  EXPORT_URL_TTL_SEC,
  EXPORTS_PER_BABY_PER_DAY,
  exportDownloadUrlResponseSchema,
  exportKey,
  exportResponseSchema,
  exportsListResponseSchema,
} from "@littlelight/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { signAccessToken } from "../testing/support";

// Data export routes (docs/plans/review-fixes.md 2.5, 2.14; PRD FR-10.1, "Roles and permissions":
// export data is Admin only). Real database, stub job queue.

describe.skipIf(!databaseUrl)("data export routes", () => {
  let h: Harness;
  const sent: { exportId: string; babyId: string }[] = [];
  let enqueueOk = true;
  let mom: TestUser; // admin, requester
  let dad: TestUser; // co-admin
  let nanny: TestUser; // contributor
  let stranger: TestUser;
  let baby: string;

  beforeAll(async () => {
    h = await createHarness({
      jobs: {
        enqueueIngest: async () => true,
        enqueueReindex: async () => true,
        enqueueShareApply: async () => true,
        enqueuePush: async () => true,
        enqueueDataExport: async (job: { exportId: string; babyId: string }) => {
          sent.push(job);
          return enqueueOk;
        },
        close: async () => undefined,
      } as never,
    });
    mom = await h.user({ displayName: "Mom" });
    dad = await h.user({ displayName: "Dad" });
    nanny = await h.user({ displayName: "Nanny" });
    stranger = await h.user();
    baby = await h.baby(mom, "Maya");
    await h.member(baby, dad, "admin");
    await h.member(baby, nanny, "contributor");
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    sent.length = 0;
    enqueueOk = true;
    await h.admin.query("DELETE FROM public.data_exports WHERE baby_id = $1", [baby]);
    await h.admin.query(
      "DELETE FROM public.audit_log WHERE baby_id = $1 AND event LIKE 'export.%'",
      [baby],
    );
  });

  const post = (u: TestUser | null, includeLocation: boolean | undefined = true, b = baby) =>
    h.inject(
      u,
      "POST",
      `/babies/${b}/exports`,
      includeLocation === undefined ? {} : { includeLocation },
    );
  const list = (u: TestUser | null, b = baby) => h.inject(u, "GET", `/babies/${b}/exports`);
  const dl = (u: TestUser | null, id: string, b = baby) =>
    h.inject(u, "POST", `/babies/${b}/exports/${id}/download-url`);
  const del = (u: TestUser | null, id: string, b = baby) =>
    h.inject(u, "DELETE", `/babies/${b}/exports/${id}`);
  const setStatus = (id: string, status: string, extra = "") =>
    h.admin.query(`UPDATE public.data_exports SET status = $2 ${extra} WHERE id = $1`, [
      id,
      status,
    ]);
  const request = async (u = mom, includeLocation = true) => {
    const res = await post(u, includeLocation);
    expect(res.statusCode, res.body).toBe(202);
    return exportResponseSchema.parse(res.json()).export;
  };

  describe("request", () => {
    it("202: queued, mine, not downloadable, job sent once with ids only, audited without data", async () => {
      const e = await request(mom, true);
      expect(e).toMatchObject({
        babyId: baby,
        status: "queued",
        includeLocation: true,
        requestedBy: mom.id,
        requestedByName: "Mom",
        isMine: true,
        photoCount: null,
        photosDone: 0,
        bytes: null,
        error: null,
        canDownload: false,
      });
      expect(sent).toEqual([{ exportId: e.id, babyId: baby }]);
      const audits = await h.audit({ event: "export.requested", baby });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor_user_id).toBe(mom.id);
      expect(audits[0]?.metadata).toEqual({ export_id: e.id, include_location: true });
      const raw = await h.admin.query(
        "SELECT include_location, requested_by FROM public.data_exports WHERE id = $1",
        [e.id],
      );
      expect(raw.rows[0]).toEqual({ include_location: true, requested_by: mom.id });
    });

    it("records include_location false", async () => {
      const e = await request(mom, false);
      expect(e.includeLocation).toBe(false);
      expect((await h.audit({ event: "export.requested", baby }))[0]?.metadata).toEqual({
        export_id: e.id,
        include_location: false,
      });
    });

    it("the co-admin can request too (as themselves)", async () => {
      const e = await request(dad);
      expect(e.requestedBy).toBe(dad.id);
      expect(e.requestedByName).toBe("Dad");
    });

    it("never returns the storage key, a URL or an email", async () => {
      const res = await post(mom);
      expect(res.body).not.toMatch(/storage|exports\/|\.zip|X-Amz|@|https?:/i);
    });

    it("a contributor gets 403 and nothing is created or sent", async () => {
      const res = await post(nanny);
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("forbidden");
      expect(sent).toEqual([]);
      const n = await h.admin.query(
        "SELECT count(*)::int AS n FROM public.data_exports WHERE baby_id = $1",
        [baby],
      );
      expect(n.rows[0].n).toBe(0);
    });

    it("a stranger gets 404 (the album's existence is not revealed); no session is 401", async () => {
      const res = await post(stranger);
      expect(res.statusCode).toBe(404);
      expect(apiErrorSchema.parse(res.json()).error).toBe("not_found");
      expect((await post(null)).statusCode).toBe(401);
      expect(sent).toEqual([]);
    });

    it("a share-link viewer token cannot reach any export route", async () => {
      const viewerToken = await signAccessToken({
        sub: "",
        role: "viewer",
        email: null,
        sessionId: null,
        extra: { share_link_id: "11111111-1111-4111-8111-111111111111" },
      });
      const headers = { authorization: `Bearer ${viewerToken}` };
      const some = "22222222-2222-4222-8222-222222222222";
      for (const [method, url] of [
        ["POST", `/babies/${baby}/exports`],
        ["GET", `/babies/${baby}/exports`],
        ["POST", `/babies/${baby}/exports/${some}/download-url`],
        ["DELETE", `/babies/${baby}/exports/${some}`],
      ] as const) {
        const res = await h.app.inject({
          method,
          url,
          headers,
          payload:
            method === "POST" && url.endsWith("exports") ? { includeLocation: true } : undefined,
        });
        expect([401, 403], `${method} ${url}`).toContain(res.statusCode);
      }
      expect(sent).toEqual([]);
    });

    it("needs a fresh sign-in: a stale session gets 403 fresh_sign_in_required and creates nothing", async () => {
      const stale = await h.user({ sessionAgeMin: 30 });
      const b = await h.baby(stale, "Stale");
      const res = await post(stale, true, b);
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("fresh_sign_in_required");
      expect(sent).toEqual([]);
      const n = await h.admin.query(
        "SELECT count(*)::int AS n FROM public.data_exports WHERE baby_id = $1",
        [b],
      );
      expect(n.rows[0].n).toBe(0);
      // a contributor with a stale session still gets 403 forbidden, not the sign-in prompt
      const staleNanny = await h.user({ sessionAgeMin: 30 });
      await h.member(b, staleNanny, "contributor");
      expect(apiErrorSchema.parse((await post(staleNanny, true, b)).json()).error).toBe(
        "forbidden",
      );
    });

    it("requires accepted terms (consent_required) before anything else", async () => {
      const noConsent = await h.user({ consent: false });
      const b = await h.baby(noConsent, "NoConsent").catch(() => null);
      if (b) {
        const res = await post(noConsent, true, b);
        expect(res.statusCode).toBe(403);
        expect(apiErrorSchema.parse(res.json()).error).toBe("consent_required");
      }
      expect(sent).toEqual([]);
    });

    it("validates the body: missing, wrong type and extra keys are 400", async () => {
      for (const body of [
        {},
        { includeLocation: "yes" },
        { includeLocation: true, babyId: baby },
      ]) {
        const res = await h.inject(mom, "POST", `/babies/${baby}/exports`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(sent).toEqual([]);
    });

    it("409 export_in_progress while one is queued or running, for either admin; the job is not sent twice", async () => {
      const e = await request(mom);
      for (const u of [mom, dad]) {
        const res = await post(u);
        expect(res.statusCode).toBe(409);
        expect(apiErrorSchema.parse(res.json()).error).toBe("export_in_progress");
      }
      await setStatus(e.id, "running");
      expect((await post(dad)).statusCode).toBe(409);
      expect(sent).toHaveLength(1);
      await setStatus(e.id, "ready");
      expect((await post(dad)).statusCode).toBe(202);
    });

    it(`429 rate_limited on request ${EXPORTS_PER_BABY_PER_DAY + 1} in 24 hours, with Retry-After`, async () => {
      for (let i = 0; i < EXPORTS_PER_BABY_PER_DAY; i++) {
        const e = await request(i % 2 === 0 ? mom : dad);
        await setStatus(e.id, "ready");
      }
      const res = await post(mom);
      expect(res.statusCode).toBe(429);
      expect(apiErrorSchema.parse(res.json()).error).toBe("rate_limited");
      expect(res.headers["retry-after"]).toBeDefined();
      expect(sent).toHaveLength(EXPORTS_PER_BABY_PER_DAY);
    });

    it("409 baby_trashed for an album in the trash, and nothing is sent", async () => {
      const b = await h.baby(mom, "Trashed");
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [b]);
      const res = await post(mom, true, b);
      expect(res.statusCode).toBe(409);
      expect(apiErrorSchema.parse(res.json()).error).toBe("baby_trashed");
      expect(sent).toEqual([]);
    });

    it("503 when the job cannot be enqueued: the row is failed/internal so a retry is not blocked", async () => {
      enqueueOk = false;
      const res = await post(mom);
      expect(res.statusCode).toBe(503);
      const row = (
        await h.admin.query("SELECT status, error FROM public.data_exports WHERE baby_id = $1", [
          baby,
        ])
      ).rows[0];
      expect(row).toEqual({ status: "failed", error: "internal" });
      enqueueOk = true;
      expect((await post(mom)).statusCode).toBe(202);
    });
  });

  describe("list", () => {
    it("both admins see every export of the album, newest first, flagged by ownership", async () => {
      const a = await request(mom);
      await setStatus(
        a.id,
        "ready",
        ", bytes = 1000, photo_count = 3, photos_done = 3, finished_at = now()",
      );
      const b = await request(dad);
      for (const [u, mineFirst] of [
        [mom, false],
        [dad, true],
      ] as const) {
        const res = await list(u);
        expect(res.statusCode).toBe(200);
        const body = exportsListResponseSchema.parse(res.json());
        expect(body.exports.map((e) => e.id)).toEqual([b.id, a.id]);
        expect(body.exports[0]?.isMine).toBe(mineFirst);
        expect(body.exports[1]?.isMine).toBe(!mineFirst);
        expect(body.exports[1]).toMatchObject({ status: "ready", bytes: 1000, photoCount: 3 });
      }
    });

    it("canDownload only for the requester of a ready, unexpired export", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      const mine = exportsListResponseSchema.parse((await list(mom)).json()).exports[0];
      const theirs = exportsListResponseSchema.parse((await list(dad)).json()).exports[0];
      expect(mine?.canDownload).toBe(true);
      expect(theirs?.canDownload).toBe(false);
      expect(theirs?.requestedByName).toBe("Mom");
    });

    it("a ready export past its expiry or purged reads as expired", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready", ", expires_at = now() - interval '1 minute'");
      const row = exportsListResponseSchema.parse((await list(mom)).json()).exports[0];
      expect(row?.status).toBe("expired");
      expect(row?.canDownload).toBe(false);
    });

    it("lists at most 10 exports", async () => {
      for (let i = 0; i < 12; i++) {
        await h.admin.query(
          "INSERT INTO public.data_exports (baby_id, requested_by, status, created_at) VALUES ($1, $2, 'expired', now() - ($3 || ' days')::interval)",
          [baby, mom.id, String(i + 2)],
        );
      }
      const body = exportsListResponseSchema.parse((await list(mom)).json());
      expect(body.exports).toHaveLength(10);
    });

    it("contributor 403, stranger 404, anonymous 401; another album's exports never appear", async () => {
      await request(mom);
      expect((await list(nanny)).statusCode).toBe(403);
      expect((await list(stranger)).statusCode).toBe(404);
      expect((await list(null)).statusCode).toBe(401);
      const otherBaby = await h.baby(stranger, "Other");
      const own = exportsListResponseSchema.parse((await list(stranger, otherBaby)).json());
      expect(own.exports).toEqual([]);
      expect((await list(stranger, baby)).statusCode).toBe(404);
    });

    it("the list works on a stale session (only mutations need a fresh sign-in)", async () => {
      const stale = await h.session(mom, { ageMin: 30 });
      const res = await h.inject(null, "GET", `/babies/${baby}/exports`, undefined, {
        authorization: `Bearer ${stale.token}`,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("download-url", () => {
    it("the requester gets a 10-minute attachment URL for exactly their ZIP; counted and audited", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready", ", bytes = 5, finished_at = now()");
      const res = await dl(mom, e.id);
      expect(res.statusCode, res.body).toBe(200);
      const body = exportDownloadUrlResponseSchema.parse(res.json());
      const url = new URL(body.url);
      expect(url.pathname.endsWith(`/${exportKey(baby, e.id)}`)).toBe(true);
      expect(url.searchParams.get("X-Amz-Expires")).toBe(String(EXPORT_URL_TTL_SEC));
      expect(url.searchParams.get("response-content-disposition")).toMatch(
        /^attachment; filename="littlelight-maya-\d{4}-\d{2}-\d{2}\.zip"$/,
      );
      expect(url.searchParams.get("response-content-type")).toBe("application/zip");
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 601_000);
      const row = (
        await h.admin.query(
          "SELECT downloads, last_downloaded_at FROM public.data_exports WHERE id = $1",
          [e.id],
        )
      ).rows[0];
      expect(row.downloads).toBe(1);
      expect(row.last_downloaded_at).not.toBeNull();
      await dl(mom, e.id);
      expect(
        (await h.admin.query("SELECT downloads FROM public.data_exports WHERE id = $1", [e.id]))
          .rows[0].downloads,
      ).toBe(2);
      const audits = await h.audit({ event: "export.downloaded", baby });
      expect(audits).toHaveLength(2);
      expect(audits[0]?.metadata).toEqual({ export_id: e.id });
      expect(JSON.stringify(audits)).not.toMatch(/X-Amz|\.zip/);
    });

    it("the co-admin is refused with 403 not_requester and nothing is counted or audited", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      const res = await dl(dad, e.id);
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("not_requester");
      expect(res.body).not.toMatch(/X-Amz|\.zip/);
      expect((await h.audit({ event: "export.downloaded", baby })).length).toBe(0);
      expect(
        (await h.admin.query("SELECT downloads FROM public.data_exports WHERE id = $1", [e.id]))
          .rows[0].downloads,
      ).toBe(0);
    });

    it("a contributor 403, a stranger 404, anonymous 401", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      expect((await dl(nanny, e.id)).statusCode).toBe(403);
      expect((await dl(stranger, e.id)).statusCode).toBe(404);
      expect((await dl(null, e.id)).statusCode).toBe(401);
    });

    it("an export id from another album is 404 (never cross-album)", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      const otherBaby = await h.baby(stranger, "Other");
      expect((await dl(stranger, e.id, otherBaby)).statusCode).toBe(404);
      expect((await dl(mom, e.id, otherBaby)).statusCode).toBe(404);
    });

    it("unknown export 404", async () => {
      expect((await dl(mom, "99999999-9999-4999-8999-999999999999")).statusCode).toBe(404);
    });

    it.each([
      ["queued", 410],
      ["running", 410],
      ["failed", 410],
      ["expired", 410],
    ])("a %s export is %s export_expired", async (status, code) => {
      const e = await request(mom);
      await setStatus(e.id, status);
      const res = await dl(mom, e.id);
      expect(res.statusCode).toBe(code);
      expect(apiErrorSchema.parse(res.json()).error).toBe("export_expired");
    });

    it("a ready export past its expiry or purged is 410 export_expired", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready", ", expires_at = now() - interval '1 second'");
      expect((await dl(mom, e.id)).statusCode).toBe(410);
      await setStatus(e.id, "ready", ", expires_at = now() + interval '1 day', purged_at = now()");
      expect((await dl(mom, e.id)).statusCode).toBe(410);
    });

    it("needs a fresh sign-in", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      const stale = await h.session(mom, { ageMin: 30 });
      const res = await h.inject(
        null,
        "POST",
        `/babies/${baby}/exports/${e.id}/download-url`,
        undefined,
        {
          authorization: `Bearer ${stale.token}`,
        },
      );
      expect(res.statusCode).toBe(403);
      expect(apiErrorSchema.parse(res.json()).error).toBe("fresh_sign_in_required");
      expect((await h.audit({ event: "export.downloaded", baby })).length).toBe(0);
    });
  });

  describe("delete (expire early)", () => {
    it("either admin: 204, expiry moves to now, the export reads expired, audited once; a repeat is a 204 without a second audit row", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      expect((await del(dad, e.id)).statusCode).toBe(204);
      const row = (
        await h.admin.query("SELECT expires_at FROM public.data_exports WHERE id = $1", [e.id])
      ).rows[0];
      expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(Date.now());
      const listed = exportsListResponseSchema.parse((await list(mom)).json()).exports[0];
      expect(listed?.status).toBe("expired");
      expect(listed?.canDownload).toBe(false);
      expect((await dl(mom, e.id)).statusCode).toBe(410);
      expect((await del(mom, e.id)).statusCode).toBe(204);
      const audits = await h.audit({ event: "export.expired", baby });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor_user_id).toBe(dad.id);
    });

    it("deleting does not remove the row or the ZIP (the sweep does)", async () => {
      const e = await request(mom);
      await setStatus(e.id, "ready");
      await del(mom, e.id);
      const row = (
        await h.admin.query("SELECT status, purged_at FROM public.data_exports WHERE id = $1", [
          e.id,
        ])
      ).rows[0];
      expect(row).toEqual({ status: "ready", purged_at: null });
    });

    it("contributor 403, stranger 404, anonymous 401, unknown id 404, other album 404", async () => {
      const e = await request(mom);
      expect((await del(nanny, e.id)).statusCode).toBe(403);
      expect((await del(stranger, e.id)).statusCode).toBe(404);
      expect((await del(null, e.id)).statusCode).toBe(401);
      expect((await del(mom, "99999999-9999-4999-8999-999999999999")).statusCode).toBe(404);
      const otherBaby = await h.baby(stranger, "Other");
      expect((await del(stranger, e.id, otherBaby)).statusCode).toBe(404);
      const row = (
        await h.admin.query(
          "SELECT expires_at > now() AS live FROM public.data_exports WHERE id = $1",
          [e.id],
        )
      ).rows[0];
      expect(row.live).toBe(true);
    });
  });

  describe("after membership changes", () => {
    it("a demoted requester loses access to the whole export surface", async () => {
      const e = await request(dad);
      await setStatus(e.id, "ready");
      await h.admin.query(
        "UPDATE public.baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
        [baby, dad.id],
      );
      try {
        expect((await list(dad)).statusCode).toBe(403);
        expect((await dl(dad, e.id)).statusCode).toBe(403);
        expect((await post(dad)).statusCode).toBe(403);
      } finally {
        await h.admin.query(
          "UPDATE public.baby_members SET role = 'admin' WHERE baby_id = $1 AND user_id = $2",
          [baby, dad.id],
        );
      }
    });
  });
});
