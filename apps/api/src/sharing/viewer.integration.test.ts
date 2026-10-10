import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  shareAlbumSchema,
  shareLinkCreatedResponseSchema,
  shareLinksResponseSchema,
  shareSessionResponseSchema,
  VIEWER_COOKIE,
  viewerDownloadResponseSchema,
  viewerPhotosResponseSchema,
  viewerUrlsResponseSchema,
} from "@littlelight/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "../app";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";
import { testConfig } from "../testing/support";
import { hashClientIp, hashShareToken } from "./crypto";

// The share-link viewer against a real database (docs/plans/step-8.md 2.6, 2.12, 4.1; PRD FR-9
// "Sharing", "Share-link viewers (no account)", "Privacy and child safety"). Step 8 acceptance:
// an expired or revoked link returns the expired page (410 share_link_expired, on the token
// exchange and on an open cookie session) and sensitive photos never auto-share / never reach a
// viewer's URLs. Media URLs are signed offline (no storage call).

const WEB = { "x-littlelight-client": "web" };
const NATIVE = { "x-littlelight-client": "native" };
const PASSCODE = "739104";
const SENTINEL_IP = "198.51.100.200";
const LINK_NAME = "SENTINEL-LINK-NAME-Grandparents";
const BABY_NAME = "SentinelBabyName";

describe.skipIf(!databaseUrl)("share-link viewer (api + db)", () => {
  let h: Harness;
  let mom: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let baby: string;
  let otherBaby: string;
  const ph: Record<string, string> = {};
  const logLines: string[] = [];
  let ipCounter = 0;
  const newIp = () => {
    ipCounter = (ipCounter % 150) + 1;
    return `198.51.100.${ipCounter}`;
  };

  interface Link {
    id: string;
    token: string;
  }
  const tokenOf = (url: string) => url.split("/s/")[1] as string;

  const keep: string[] = []; // the shared fixture links are never pruned
  async function createLink(body: Record<string, unknown> = {}, babyId = baby): Promise<Link> {
    // Stay under the 20-link cap whatever the number of tests (oldest scratch links go first).
    await h.admin.query(
      `DELETE FROM public.share_links WHERE id IN (
         SELECT id FROM public.share_links WHERE baby_id = $1 AND id <> ALL($2::uuid[])
          ORDER BY created_at DESC, id DESC OFFSET 12)`,
      [babyId, keep],
    );
    const res = await h.inject(mom, "POST", `/babies/${babyId}/share-links`, {
      name: LINK_NAME,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = shareLinkCreatedResponseSchema.parse(res.json());
    return { id: created.link.id, token: tokenOf(created.url) };
  }
  const addPhotos = async (link: Link, ids: string[], showSensitive = false) => {
    const res = await h.inject(mom, "POST", `/share-links/${link.id}/photos`, {
      photoIds: ids,
      showSensitive,
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  const exchange = (
    token: string,
    o: { passcode?: string; cookie?: string; ip?: string; headers?: Record<string, string> } = {},
  ) =>
    h.app.inject({
      method: "POST",
      url: "/share/session",
      headers: {
        ...WEB,
        "cf-connecting-ip": o.ip ?? newIp(),
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1",
        ...(o.cookie ? { cookie: `${VIEWER_COOKIE}=${o.cookie}` } : {}),
        ...o.headers,
      },
      payload: { token, ...(o.passcode !== undefined ? { passcode: o.passcode } : {}) },
    });
  const cookieValue = (res: LightMyRequestResponse) =>
    res.cookies.find((c) => c.name === VIEWER_COOKIE)?.value;
  async function open(link: Link, o: { passcode?: string; ip?: string } = {}): Promise<string> {
    const res = await exchange(link.token, o);
    expect(res.statusCode, res.body).toBe(200);
    const v = cookieValue(res);
    expect(v).toBeTruthy();
    return v as string;
  }
  const vget = (cookie: string, url: string, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: "GET",
      url,
      headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...headers },
    });
  const vpost = (cookie: string, url: string, body: unknown = {}) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...WEB },
      payload: body as object,
    });
  const expectExpired = (res: LightMyRequestResponse) => {
    expect(res.statusCode, res.body).toBe(410);
    const err = apiErrorSchema.parse(res.json());
    expect(err.error).toBe("share_link_expired");
    expect(err.message).toBe("This link has expired. Ask the parents for a new link.");
  };
  const errorOf = (res: LightMyRequestResponse) => apiErrorSchema.parse(res.json());
  const setLinkSql = (id: string, sql: string) =>
    h.admin.query(`UPDATE public.share_links SET ${sql} WHERE id = $1`, [id]);

  // Links shared by the "album" scenarios.
  let album: Link; // a, b, sens (hidden); downloads off
  let other: Link; // c only; downloads on
  let dl: Link; // a, sens; downloads on

  beforeAll(async () => {
    h = await createHarness({
      logger: {
        ...loggerOptions(testConfig()),
        level: "info",
        stream: { write: (s: string) => void logLines.push(s) },
      },
    });
    mom = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    baby = await h.baby(mom, BABY_NAME);
    otherBaby = await h.baby(stranger, "Other baby");
    await h.member(baby, nanny, "contributor");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby]);
    const mk = (key: string, babyId: string, o: Parameters<typeof seedPhoto>[2] = {}) =>
      seedPhoto(h.admin, babyId, {
        uploadedBy: mom.id,
        withThumb: true,
        withDisplay: true,
        withAnalysis: true,
        ...o,
      }).then((id) => {
        ph[key] = id;
      });
    await mk("a", baby, { takenAt: "2026-06-10T10:00:00Z" });
    await mk("b", baby, { takenAt: "2026-06-11T10:00:00Z" });
    await mk("c", baby, { takenAt: "2026-06-12T10:00:00Z" });
    await mk("sens", baby, { takenAt: "2026-06-13T10:00:00Z" });
    await mk("gone", baby, { takenAt: "2026-06-14T10:00:00Z" });
    await mk("foreign", otherBaby);
    await h.admin.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [ph.sens]);
    // a milestone for the tagged photo
    await h.admin.query(
      `INSERT INTO public.photo_details (photo_id, milestone_id, edited_by)
       VALUES ($1, '10000000-0000-4000-8000-000000000008', $2)`,
      [ph.b, mom.id],
    );

    album = await createLink();
    keep.push(album.id);
    await addPhotos(album, [ph.a, ph.b, ph.sens, ph.gone] as string[]);
    await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [ph.gone]);
    other = await createLink({ allowDownload: true });
    keep.push(other.id);
    await addPhotos(other, [ph.c] as string[]);
    dl = await createLink({ allowDownload: true });
    keep.push(dl.id);
    await addPhotos(dl, [ph.a, ph.sens] as string[]);
  });
  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  describe("token exchange", () => {
    it("opens the album: ll_viewer is HttpOnly, SameSite=Lax, Path=/api/share; the body has no token or JWT", async () => {
      const res = await exchange(album.token);
      expect(res.statusCode, res.body).toBe(200);
      const header = String(res.headers["set-cookie"]);
      expect(header).toMatch(/^ll_viewer=[A-Za-z0-9_.-]+;/);
      expect(header).toMatch(/Path=\/api\/share/);
      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/SameSite=Lax/);
      expect(header).toMatch(/Max-Age=\d+/);
      expect(/;\s*Secure/i.test(header)).toBe(false); // NODE_ENV=test, Secure only in production
      const body = shareSessionResponseSchema.parse(res.json());
      expect(body.viewerToken).toBeUndefined();
      expect(body.album).toMatchObject({
        linkName: LINK_NAME,
        babyName: BABY_NAME,
        allowDownload: false,
        photoCount: 3, // a, b and the hidden tile; the trashed one is gone
        hiddenCount: 1,
      });
      expect(res.body).not.toContain(album.token);
      expect(res.body).not.toContain(cookieValue(res) as string);
      const ms = Date.parse(body.album.expiresAt) - Date.now();
      expect(Math.abs(ms - 24 * 3600_000)).toBeLessThan(2 * 60_000);
    });

    it("the Max-Age follows the link's expiry (JWT exp = link expiry)", async () => {
      const short = await createLink({ ttlHours: 1 });
      const res = await exchange(short.token);
      const maxAge = Number(/Max-Age=(\d+)/.exec(String(res.headers["set-cookie"]))?.[1]);
      expect(maxAge).toBeLessThanOrEqual(3600);
      expect(maxAge).toBeGreaterThan(3500);
      const payload = JSON.parse(
        Buffer.from((cookieValue(res) as string).split(".")[1] as string, "base64url").toString(),
      );
      const { rows } = await h.admin.query(
        "SELECT expires_at FROM public.share_links WHERE id = $1",
        [short.id],
      );
      expect(payload.exp).toBe(Math.floor(rows[0].expires_at.getTime() / 1000));
      expect(payload.role).toBe("viewer");
      expect(payload.share_link_id).toBe(short.id);
    });

    it("needs X-Littlelight-Client (403 csrf_rejected); a malformed token shape is 400; unknown is 410", async () => {
      const bare = await h.app.inject({
        method: "POST",
        url: "/share/session",
        payload: { token: album.token },
      });
      expect(bare.statusCode).toBe(403);
      expect(errorOf(bare).error).toBe("csrf_rejected");
      for (const bad of [
        "short",
        "has space has space has",
        "x".repeat(65),
        "<script>alert(1)</script>",
      ]) {
        const res = await exchange(bad);
        expect(res.statusCode, bad).toBe(400);
      }
      expectExpired(await exchange("A".repeat(22)));
      expectExpired(await exchange("demo-grandparents-share-token-nope"));
    });

    it("an extra body key is a 400 (strict body)", async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/share/session",
        headers: { ...WEB, "cf-connecting-ip": newIp() },
        payload: { token: album.token, role: "admin" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("native clients get the viewer JWT in the body and no cookie; it works as a bearer", async () => {
      const res = await exchange(album.token, { headers: NATIVE });
      expect(res.statusCode, res.body).toBe(200);
      expect(cookieValue(res)).toBeUndefined();
      const body = shareSessionResponseSchema.parse(res.json());
      expect(body.viewerToken).toBeTruthy();
      const viaBearer = await h.app.inject({
        method: "GET",
        url: "/share/album",
        headers: { ...NATIVE, authorization: `Bearer ${body.viewerToken}` },
      });
      expect(viaBearer.statusCode, viaBearer.body).toBe(200);
      // the same token without the native header is not a credential on the web
      const web = await h.app.inject({
        method: "GET",
        url: "/share/album",
        headers: { authorization: `Bearer ${body.viewerToken}` },
      });
      expect(web.statusCode).toBe(401);
    });

    it("counts one visit per session and stores keyed hashes, never the IP or the user agent", async () => {
      const link = await createLink();
      const ip = "203.0.113.55";
      const cookie = await open(link, { ip });
      const { rows } = await h.admin.query(
        "SELECT view_count, last_viewed_at FROM public.share_links WHERE id = $1",
        [link.id],
      );
      expect(rows[0].view_count).toBe(1);
      expect(rows[0].last_viewed_at).not.toBeNull();
      // reusing the live cookie: no new session, no extra visit
      const again = await exchange(link.token, { cookie, ip });
      expect(again.statusCode).toBe(200);
      const count = await h.admin.query(
        "SELECT view_count, (SELECT count(*)::int FROM public.viewer_sessions WHERE share_link_id = $1) AS sessions FROM public.share_links WHERE id = $1",
        [link.id],
      );
      expect(count.rows[0]).toMatchObject({ view_count: 1, sessions: 1 });
      const s = await h.admin.query(
        "SELECT ip_hash, user_agent_hash, id FROM public.viewer_sessions WHERE share_link_id = $1",
        [link.id],
      );
      expect(s.rows[0].ip_hash).toHaveLength(32);
      expect(s.rows[0].ip_hash.equals(hashClientIp(h.config, ip))).toBe(true);
      expect(s.rows[0].user_agent_hash).toHaveLength(32);
      const dump = await h.admin.query(
        "SELECT row_to_json(v)::text j FROM public.viewer_sessions v WHERE share_link_id = $1",
        [link.id],
      );
      expect(dump.rows[0].j).not.toContain(ip);
      expect(dump.rows[0].j).not.toContain("iPhone");
      // the link's detail for the parent: one active viewer
      const list = shareLinksResponseSchema.parse(
        (await h.inject(mom, "GET", `/babies/${baby}/share-links`)).json(),
      );
      expect(list.links.find((l) => l.id === link.id)).toMatchObject({
        viewCount: 1,
        activeViewers: 1,
      });
    });

    it("sign-out clears the cookie, ends the session (410 after), and needs the web header", async () => {
      const link = await createLink();
      const cookie = await open(link);
      const bare = await h.app.inject({
        method: "DELETE",
        url: "/share/session",
        headers: { cookie: `${VIEWER_COOKIE}=${cookie}` },
      });
      expect(bare.statusCode).toBe(403);
      expect((await vget(cookie, "/share/album")).statusCode).toBe(200);
      const out = await h.app.inject({
        method: "DELETE",
        url: "/share/session",
        headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...WEB },
      });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers["set-cookie"])).toMatch(/ll_viewer=;/);
      expectExpired(await vget(cookie, "/share/album"));
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("ACCEPTANCE: expired, revoked and regenerated links return the expired page", () => {
    it("an EXPIRED link (expires_at in the past via SQL): exchange 410 and an open cookie session 410; renew brings it back", async () => {
      const link = await createLink();
      const cookie = await open(link);
      expect((await vget(cookie, "/share/album")).statusCode).toBe(200);

      await setLinkSql(link.id, "expires_at = now() - interval '1 minute'");
      expectExpired(await exchange(link.token));
      const live = await vget(cookie, "/share/album");
      expectExpired(live);
      expect(String(live.headers["set-cookie"])).toMatch(/ll_viewer=;/); // cleared
      for (const url of ["/share/photos", "/share/album"]) expectExpired(await vget(cookie, url));
      expectExpired(await vpost(cookie, "/share/photos/urls", { ids: [ph.a], kind: "thumb" }));
      expectExpired(await vpost(cookie, `/share/photos/${ph.a}/download`));
      // the parent sees it as expired, not revoked
      const list = shareLinksResponseSchema.parse(
        (await h.inject(mom, "GET", `/babies/${baby}/share-links`)).json(),
      );
      expect(list.links.find((l) => l.id === link.id)?.status).toBe("expired");

      // renew: the same token works again
      const renewed = await h.inject(mom, "POST", `/share-links/${link.id}/renew`, {});
      expect(renewed.statusCode, renewed.body).toBe(200);
      const back = await exchange(link.token);
      expect(back.statusCode, back.body).toBe(200);
      expect(shareAlbumSchema.parse(back.json().album).linkName).toBe(LINK_NAME);
    });

    it("a REVOKED link: exchange 410, open cookie 410 on every route, renew is 409", async () => {
      const link = await createLink();
      const cookie = await open(link);
      expect((await h.inject(mom, "POST", `/share-links/${link.id}/revoke`, {})).statusCode).toBe(
        200,
      );
      expectExpired(await exchange(link.token));
      expectExpired(await vget(cookie, "/share/album"));
      expectExpired(await vget(cookie, "/share/photos"));
      expectExpired(await vpost(cookie, "/share/photos/urls", { ids: [ph.a], kind: "thumb" }));
      const renew = await h.inject(mom, "POST", `/share-links/${link.id}/renew`, {});
      expect(renew.statusCode).toBe(409);
      expect(errorOf(renew).error).toBe("conflict");
      expectExpired(await exchange(link.token)); // still dead
    });

    it("a REGENERATED link: the old token and old cookie are 410, the new token works", async () => {
      const link = await createLink();
      await addPhotos(link, [ph.a] as string[]);
      const cookie = await open(link);
      const res = await h.inject(mom, "POST", `/share-links/${link.id}/regenerate`, {});
      expect(res.statusCode, res.body).toBe(200);
      const next = tokenOf(shareLinkCreatedResponseSchema.parse(res.json()).url);
      expect(next).not.toBe(link.token);
      expectExpired(await exchange(link.token));
      expectExpired(await vget(cookie, "/share/album"));
      const fresh = await exchange(next);
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect((await vget(cookieValue(fresh) as string, "/share/photos")).statusCode).toBe(200);
    });

    it("revoke then regenerate revives the link with the new token only", async () => {
      const link = await createLink();
      await h.inject(mom, "POST", `/share-links/${link.id}/revoke`, {});
      const res = await h.inject(mom, "POST", `/share-links/${link.id}/regenerate`, {});
      const next = tokenOf(shareLinkCreatedResponseSchema.parse(res.json()).url);
      expectExpired(await exchange(link.token));
      expect((await exchange(next)).statusCode).toBe(200);
    });

    it("deleting the link, trashing the baby and changing the passcode all kill open sessions", async () => {
      const gone = await createLink();
      const c1 = await open(gone);
      await h.inject(mom, "DELETE", `/share-links/${gone.id}`);
      expectExpired(await vget(c1, "/share/album"));
      expectExpired(await exchange(gone.token));

      const pass = await createLink({ passcode: PASSCODE });
      const c2 = await open(pass, { passcode: PASSCODE });
      expect((await vget(c2, "/share/album")).statusCode).toBe(200);
      await h.inject(mom, "PATCH", `/share-links/${pass.id}`, { passcode: "246810" });
      expectExpired(await vget(c2, "/share/album"));
      expect((await exchange(pass.token, { passcode: PASSCODE })).statusCode).toBe(401);
      expect((await exchange(pass.token, { passcode: "246810" })).statusCode).toBe(200);

      const trash = await createLink();
      const c3 = await open(trash);
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [baby]);
      try {
        expectExpired(await vget(c3, "/share/album"));
        expectExpired(await exchange(trash.token));
      } finally {
        await h.admin.query("UPDATE public.babies SET deleted_at = NULL WHERE id = $1", [baby]);
      }
      expect((await exchange(trash.token)).statusCode).toBe(200);
    });

    it("an expired JWT cookie is a 401 (open the link again), not a crash", async () => {
      const bad = await vget("not.a.jwt", "/share/album");
      expect(bad.statusCode).toBe(401);
      expect(errorOf(bad).error).toBe("unauthorized");
      expect((await h.app.inject({ method: "GET", url: "/share/album" })).statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("what a viewer can see", () => {
    it("lists newest first with exact keys: no babyId, caption, isSensitive, displayUrl or GPS", async () => {
      const cookie = await open(album);
      const res = await vget(cookie, "/share/photos");
      expect(res.statusCode, res.body).toBe(200);
      const body = viewerPhotosResponseSchema.parse(res.json());
      expect(body.photos.map((p) => p.id)).toEqual([ph.sens, ph.b, ph.a]);
      expect(body.nextCursor).toBeNull();
      for (const p of res.json().photos as Record<string, unknown>[]) {
        expect(Object.keys(p).sort()).toEqual(
          [
            "ageDays",
            "height",
            "hidden",
            "id",
            "milestone",
            "takenAt",
            "takenAtEstimated",
            "thumbUrl",
            "urlExpiresAt",
            "width",
          ].sort(),
        );
      }
      const text = res.body;
      for (const banned of [
        "babyId",
        "baby_id",
        "caption",
        "isSensitive",
        "is_sensitive",
        "displayUrl",
        "gps",
        "lat",
        "uploader",
        "approval",
        "originals",
        "analysis",
      ]) {
        expect(text, banned).not.toContain(banned);
      }
      const b = body.photos.find((p) => p.id === ph.b);
      expect(b?.milestone).toEqual({
        id: "10000000-0000-4000-8000-000000000008",
        name: "First steps",
      });
    });

    it("takenAt is a UTC calendar date: no time of day ever reaches a viewer (D19)", async () => {
      const cookie = await open(album);
      const res = await vget(cookie, "/share/photos");
      const photos = res.json().photos as { id: string; takenAt: string | null }[];
      for (const p of photos) expect(p.takenAt, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.fromEntries(photos.map((p) => [p.id, p.takenAt]))).toMatchObject({
        [ph.a as string]: "2026-06-10",
        [ph.b as string]: "2026-06-11",
        [ph.sens as string]: "2026-06-13",
      });
    });

    it("takenAt is the UTC date regardless of the photo's local offset or the server time zone, and null stays null", async () => {
      // 23:30 UTC and 00:30 UTC straddle midnight: the date is the UTC one, as documented.
      const late = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        withThumb: true,
        takenAt: "2026-03-01T23:30:00Z",
      });
      const early = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        withThumb: true,
        takenAt: "2026-03-02T00:30:00Z",
      });
      const undated = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, withThumb: true });
      await h.admin.query("UPDATE public.photos SET taken_at = NULL WHERE id = $1", [undated]);
      const link = await createLink();
      keep.push(link.id);
      await addPhotos(link, [late, early, undated]);
      const cookie = await open(link);
      const photos = (await vget(cookie, "/share/photos")).json().photos as {
        id: string;
        takenAt: string | null;
      }[];
      const by = Object.fromEntries(photos.map((p) => [p.id, p.takenAt]));
      expect(by[late]).toBe("2026-03-01");
      expect(by[early]).toBe("2026-03-02");
      expect(by[undated]).toBeNull();
    });

    it("the hidden sensitive tile has thumbUrl null and no URL from /share/photos/urls", async () => {
      const cookie = await open(album);
      const list = viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json());
      const hidden = list.photos.find((p) => p.id === ph.sens);
      expect(hidden).toMatchObject({ hidden: true, thumbUrl: null, urlExpiresAt: null });
      expect(list.photos.filter((p) => p.hidden)).toHaveLength(1);
      for (const kind of ["thumb", "display"] as const) {
        const res = await vpost(cookie, "/share/photos/urls", { ids: [ph.sens, ph.a], kind });
        expect(res.statusCode, res.body).toBe(200);
        const urls = viewerUrlsResponseSchema.parse(res.json()).urls;
        expect(urls.map((u) => u.id)).toEqual([ph.a]);
        expect(res.body).not.toContain(ph.sens as string);
        expect(res.body).not.toMatch(/analysis|originals/);
      }
    });

    it("once an admin shows the sensitive photo it gets a URL; hiding it again removes it", async () => {
      const link = await createLink();
      await addPhotos(link, [ph.a, ph.sens] as string[]);
      const cookie = await open(link);
      const urlFor = async () =>
        viewerUrlsResponseSchema
          .parse(
            (await vpost(cookie, "/share/photos/urls", { ids: [ph.sens], kind: "thumb" })).json(),
          )
          .urls.map((u) => u.id);
      expect(await urlFor()).toEqual([]);
      await h.inject(mom, "PATCH", `/share-links/${link.id}/photos/${ph.sens}`, {
        showSensitive: true,
      });
      expect(await urlFor()).toEqual([ph.sens]);
      const shown = viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json());
      expect(shown.photos.find((p) => p.id === ph.sens)).toMatchObject({ hidden: false });
      expect(shown.photos.find((p) => p.id === ph.sens)?.thumbUrl).toBeTruthy();
      await h.inject(mom, "PATCH", `/share-links/${link.id}/photos/${ph.sens}`, {
        showSensitive: false,
      });
      expect(await urlFor()).toEqual([]);
    });

    it("a photo that becomes sensitive after being rule-shared disappears for the viewer (never auto-shares)", async () => {
      const babyId = await h.baby(mom, "Rule baby");
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [babyId]);
      const p = await seedPhoto(h.admin, babyId, {
        uploadedBy: mom.id,
        withThumb: true,
        withDisplay: true,
      });
      await h.admin.query(
        `INSERT INTO public.photo_ai (photo_id, model, prompt_version, schema_version, description)
         VALUES ($1, 'fake', 'v1', 'v1', '{}'::jsonb)`,
        [p],
      );
      const link = await createLink({ rule: { mode: "all" } }, babyId);
      await h.admin.query(
        "INSERT INTO public.shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')",
        [link.id, p],
      );
      const cookie = await open(link);
      expect(
        viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json()).photos,
      ).toHaveLength(1);
      await h.admin.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [p]);
      expect(
        viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json()).photos,
      ).toHaveLength(0);
      const { rows } = await h.admin.query(
        "SELECT count(*)::int n FROM public.shared_photos WHERE share_link_id = $1",
        [link.id],
      );
      expect(rows[0].n).toBe(0);
      expect(shareAlbumSchema.parse((await vget(cookie, "/share/album")).json())).toMatchObject({
        photoCount: 0,
        hiddenCount: 0,
      });
    });

    it("a viewer of link A never gets link B's photos, even with B's ids on urls and download", async () => {
      const cookieA = await open(album);
      // `c` is only on `other`; `foreign` belongs to another baby; `gone` is trashed
      const urls = await vpost(cookieA, "/share/photos/urls", {
        ids: [ph.c, ph.foreign, ph.gone, ph.a],
        kind: "thumb",
      });
      expect(viewerUrlsResponseSchema.parse(urls.json()).urls.map((u) => u.id)).toEqual([ph.a]);
      const listed = viewerPhotosResponseSchema.parse(
        (await vget(cookieA, "/share/photos")).json(),
      );
      expect(listed.photos.map((p) => p.id)).not.toContain(ph.c);

      const cookieB = await open(other);
      expect(
        viewerPhotosResponseSchema
          .parse((await vget(cookieB, "/share/photos")).json())
          .photos.map((p) => p.id),
      ).toEqual([ph.c]);
      // B's viewer: downloads are on, but A's photos are not in B
      for (const id of [ph.a, ph.b, ph.sens, ph.foreign, ph.gone]) {
        const res = await vpost(cookieB, `/share/photos/${id}/download`);
        expect(res.statusCode, `download ${id}`).toBe(404);
      }
      expect((await vpost(cookieB, `/share/photos/${ph.c}/download`)).statusCode).toBe(200);
      // A's viewer: downloads are off, so even its own photo is refused
      expect((await vpost(cookieA, `/share/photos/${ph.c}/download`)).statusCode).toBe(403);
    });

    it("pages newest first with a keyset cursor; a bad cursor or limit is 400", async () => {
      const link = await createLink();
      await addPhotos(link, [ph.a, ph.b, ph.c] as string[]);
      const cookie = await open(link);
      const first = viewerPhotosResponseSchema.parse(
        (await vget(cookie, "/share/photos?limit=2")).json(),
      );
      expect(first.photos.map((p) => p.id)).toEqual([ph.c, ph.b]);
      expect(first.nextCursor).toBeTruthy();
      const second = viewerPhotosResponseSchema.parse(
        (
          await vget(
            cookie,
            `/share/photos?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
          )
        ).json(),
      );
      expect(second.photos.map((p) => p.id)).toEqual([ph.a]);
      expect(second.nextCursor).toBeNull();
      expect((await vget(cookie, "/share/photos?cursor=garbage")).statusCode).toBe(400);
      expect((await vget(cookie, "/share/photos?limit=0")).statusCode).toBe(400);
      expect((await vget(cookie, "/share/photos?limit=201")).statusCode).toBe(400);
    });

    it("signed URLs: private cache control, thumb/display keys only, TTL <= SHARE_MEDIA_URL_TTL_SEC and <= link expiry", async () => {
      const cookie = await open(album);
      const list = viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json());
      const urls = [
        ...list.photos.flatMap((p) => (p.thumbUrl ? [p.thumbUrl] : [])),
        ...viewerUrlsResponseSchema
          .parse(
            (
              await vpost(cookie, "/share/photos/urls", { ids: [ph.a, ph.b], kind: "display" })
            ).json(),
          )
          .urls.map((u) => u.url),
      ];
      expect(urls.length).toBe(4);
      for (const url of urls) {
        const u = new URL(url);
        expect(u.pathname).toMatch(/\/derivatives\/[0-9a-f-]{36}\/(thumb|display)\.jpg$/);
        expect(u.pathname).not.toMatch(/originals|analysis/);
        expect(u.searchParams.get("response-cache-control")).toMatch(/^private, max-age=\d+$/);
        const ttl = Number(u.searchParams.get("X-Amz-Expires"));
        expect(ttl).toBeLessThanOrEqual(300);
        expect(ttl).toBeGreaterThan(0);
      }
      // a link about to expire gets a shorter TTL
      const soon = await createLink();
      await addPhotos(soon, [ph.a] as string[]);
      const c2 = await open(soon);
      await setLinkSql(soon.id, "expires_at = now() + interval '45 seconds'");
      const res = await vpost(c2, "/share/photos/urls", { ids: [ph.a], kind: "thumb" });
      expect(res.statusCode, res.body).toBe(200);
      const ttl = Number(
        new URL(viewerUrlsResponseSchema.parse(res.json()).urls[0]?.url as string).searchParams.get(
          "X-Amz-Expires",
        ),
      );
      expect(ttl).toBeLessThanOrEqual(45);
    });

    it("urls validates: an `analysis` or `original` kind, too many or non-uuid ids are 400", async () => {
      const cookie = await open(album);
      for (const bad of [
        { ids: [ph.a], kind: "analysis" },
        { ids: [ph.a], kind: "original" },
        { ids: [], kind: "thumb" },
        { ids: ["nope"], kind: "thumb" },
        { ids: Array.from({ length: 201 }, () => randomUUID()), kind: "thumb" },
        { ids: [ph.a], kind: "thumb", extra: 1 },
      ]) {
        expect(
          (await vpost(cookie, "/share/photos/urls", bad)).statusCode,
          JSON.stringify(bad).slice(0, 60),
        ).toBe(400);
      }
    });

    it("the viewer has no write or other routes: chat, search, parent photos, album writes are not there", async () => {
      const cookie = await open(album);
      for (const [method, url] of [
        ["GET", "/share/chat"],
        ["POST", "/share/chat/messages"],
        ["GET", "/share/search"],
        ["GET", `/share/babies/${baby}/photos`],
        ["PUT", "/share/photos"],
        ["DELETE", "/share/photos"],
      ] as const) {
        const res = await h.app.inject({
          method,
          url,
          headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...WEB },
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("downloads", () => {
    it("403 forbidden when the link does not allow them", async () => {
      const cookie = await open(album);
      const res = await vpost(cookie, `/share/photos/${ph.a}/download`);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).error).toBe("forbidden");
      expect(errorOf(res).message).toBe("Downloads are turned off for this album");
    });

    it("when allowed: the display copy only, as an attachment with an ASCII name, valid 60 s, private", async () => {
      const cookie = await open(dl);
      const res = await vpost(cookie, `/share/photos/${ph.a}/download`);
      expect(res.statusCode, res.body).toBe(200);
      const { url, expiresAt } = viewerDownloadResponseSchema.parse(res.json());
      const u = new URL(url);
      expect(u.pathname).toMatch(new RegExp(`/derivatives/${ph.a}/display\\.jpg$`));
      expect(u.pathname).not.toMatch(/originals|thumb|analysis/);
      expect(u.searchParams.get("response-content-disposition")).toBe(
        'attachment; filename="SentinelBabyName-2026-06-10.jpg"',
      );
      expect(u.searchParams.get("response-cache-control")).toMatch(/^private/);
      expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(60);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
    });

    it("a hidden sensitive photo is 404 even where downloads are on; shown, it downloads", async () => {
      const cookie = await open(dl);
      expect((await vpost(cookie, `/share/photos/${ph.sens}/download`)).statusCode).toBe(404);
      await h.inject(mom, "PATCH", `/share-links/${dl.id}/photos/${ph.sens}`, {
        showSensitive: true,
      });
      try {
        expect((await vpost(cookie, `/share/photos/${ph.sens}/download`)).statusCode).toBe(200);
      } finally {
        await h.inject(mom, "PATCH", `/share-links/${dl.id}/photos/${ph.sens}`, {
          showSensitive: false,
        });
      }
      expect((await vpost(cookie, `/share/photos/${ph.sens}/download`)).statusCode).toBe(404);
      expect((await vpost(cookie, `/share/photos/${randomUUID()}/download`)).statusCode).toBe(404);
      expect((await vpost(cookie, "/share/photos/not-a-uuid/download")).statusCode).toBe(400);
    });

    it("download needs the web header on the cookie transport (CSRF)", async () => {
      const cookie = await open(dl);
      const res = await h.app.inject({
        method: "POST",
        url: `/share/photos/${ph.a}/download`,
        headers: { cookie: `${VIEWER_COOKIE}=${cookie}` },
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).error).toBe("csrf_rejected");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("passcode and lockout", () => {
    it("required first (not a failure), invalid with attemptsLeft 4..0, then 429 rate_limited for the 6th even with the right code", async () => {
      const link = await createLink({ passcode: PASSCODE });
      const ip = newIp();
      const none = await exchange(link.token, { ip });
      expect(none.statusCode).toBe(401);
      expect(errorOf(none).error).toBe("passcode_required");
      for (const left of [4, 3, 2, 1, 0]) {
        const res = await exchange(link.token, { ip, passcode: "000000" });
        expect(res.statusCode).toBe(401);
        const err = errorOf(res);
        expect(err.error).toBe("passcode_invalid");
        expect(err.details).toEqual({ attemptsLeft: left });
      }
      const sixth = await exchange(link.token, { ip, passcode: PASSCODE });
      expect(sixth.statusCode).toBe(429);
      expect(errorOf(sixth).error).toBe("rate_limited");
      expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
      expect(cookieValue(sixth)).toBeUndefined();
      // another IP is unaffected, and the right code opens the album
      const ok = await exchange(link.token, { passcode: PASSCODE });
      expect(ok.statusCode, ok.body).toBe(200);
      // the failures were stored against a keyed hash, not the IP
      const { rows } = await h.admin.query(
        "SELECT ip_hash FROM public.share_passcode_failures WHERE share_link_id = $1",
        [link.id],
      );
      expect(rows).toHaveLength(5);
      expect(rows[0].ip_hash.equals(hashClientIp(h.config, ip))).toBe(true);
    });

    it("a malformed passcode shape is 400 and not a recorded failure", async () => {
      const link = await createLink({ passcode: PASSCODE });
      for (const bad of ["12345", "1234567", "abcdef", ""]) {
        expect((await exchange(link.token, { passcode: bad })).statusCode, bad).toBe(400);
      }
      const { rows } = await h.admin.query(
        "SELECT count(*)::int n FROM public.share_passcode_failures WHERE share_link_id = $1",
        [link.id],
      );
      expect(rows[0].n).toBe(0);
    });

    it("20 failures across 4 IPs lock the link: a fifth IP with the right code is 429 passcode_locked; regenerate clears it", async () => {
      const link = await createLink({ passcode: PASSCODE });
      const ips = [newIp(), newIp(), newIp(), newIp()];
      for (const ip of ips) {
        for (let i = 0; i < 5; i++) {
          const res = await exchange(link.token, { ip, passcode: "111111" });
          expect(res.statusCode).toBe(401);
        }
      }
      const fifth = await exchange(link.token, { passcode: PASSCODE });
      expect(fifth.statusCode).toBe(429);
      expect(errorOf(fifth).error).toBe("passcode_locked");
      expect(Number(fifth.headers["retry-after"])).toBeGreaterThan(0);
      expect(cookieValue(fifth)).toBeUndefined();
      // the parent sees the warning and one audit row (no actor), without secrets
      const list = shareLinksResponseSchema.parse(
        (await h.inject(mom, "GET", `/babies/${baby}/share-links`)).json(),
      );
      expect(list.links.find((l) => l.id === link.id)?.passcodeLocked).toBe(true);
      const audits = await h.admin.query(
        "SELECT actor_user_id, metadata FROM public.audit_log WHERE event = 'share_link.passcode_locked' AND share_link_id = $1",
        [link.id],
      );
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0].actor_user_id).toBeNull();
      expect(audits.rows[0].metadata).toEqual({});
      // regenerate clears the lock (failures before token_rotated_at no longer count)
      const res = await h.inject(mom, "POST", `/share-links/${link.id}/regenerate`, {});
      const next = tokenOf(shareLinkCreatedResponseSchema.parse(res.json()).url);
      expectExpired(await exchange(link.token, { passcode: PASSCODE }));
      const ok = await exchange(next, { ip: ips[0], passcode: PASSCODE });
      expect(ok.statusCode, ok.body).toBe(200);
      const after = shareLinksResponseSchema.parse(
        (await h.inject(mom, "GET", `/babies/${baby}/share-links`)).json(),
      );
      expect(after.links.find((l) => l.id === link.id)?.passcodeLocked).toBe(false);
    });

    it("a live cookie skips the passcode prompt on reload; a different link's cookie does not", async () => {
      const link = await createLink({ passcode: PASSCODE });
      const cookie = await open(link, { passcode: PASSCODE });
      const reload = await exchange(link.token, { cookie });
      expect(reload.statusCode, reload.body).toBe(200);
      expect(shareAlbumSchema.parse(reload.json().album).linkName).toBe(LINK_NAME);
      // this browser's cookie for `album` does not skip the passcode of `link`
      const otherCookie = await open(album);
      const prompt = await exchange(link.token, { cookie: otherCookie });
      expect(prompt.statusCode).toBe(401);
      expect(errorOf(prompt).error).toBe("passcode_required");
    });

    it("a hash this API cannot verify (argon2id fixture) never opens the link, even with the right-looking code", async () => {
      const link = await createLink();
      await setLinkSql(link.id, "passcode_hash = 'argon2id$fixture-passcode-hash'");
      const res = await exchange(link.token, { passcode: PASSCODE });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).error).toBe("passcode_invalid");
    });

    it("exchange throttle: more than 120 exchanges per IP per hour is 429 with Retry-After", async () => {
      const ip = "192.0.2.77";
      let last: LightMyRequestResponse | undefined;
      for (let i = 0; i < 121; i++) last = await exchange("B".repeat(22), { ip });
      expect(last?.statusCode).toBe(429);
      expect(Number(last?.headers["retry-after"])).toBeGreaterThan(0);
      // a different IP is fine
      expect((await exchange("B".repeat(22))).statusCode).toBe(410);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("credentials never cross", () => {
    it("a viewer JWT as ll_access or as a bearer on parent routes is 401; the ll_viewer cookie never authenticates a parent route", async () => {
      const cookie = await open(album);
      const routes: Array<[string, string, unknown?]> = [
        ["GET", `/babies/${baby}/photos`],
        ["GET", `/babies/${baby}/chat/thread`],
        ["POST", `/babies/${baby}/chat/messages`, { text: "hi" }],
        ["GET", `/babies/${baby}/search?q=bath`],
        ["GET", `/photos/${ph.a}/original`],
        ["GET", `/babies/${baby}/share-links`],
        ["GET", "/me"],
      ];
      for (const [method, url, body] of routes) {
        const asAccess = await h.app.inject({
          method: method as "GET",
          url,
          headers: { cookie: `ll_access=${cookie}`, ...WEB },
          ...(body ? { payload: body as object } : {}),
        });
        expect(asAccess.statusCode, `ll_access ${method} ${url}`).toBe(401);
        const asBearer = await h.app.inject({
          method: method as "GET",
          url,
          headers: { authorization: `Bearer ${cookie}` },
          ...(body ? { payload: body as object } : {}),
        });
        expect(asBearer.statusCode, `bearer ${method} ${url}`).toBe(401);
        const asViewerCookie = await h.app.inject({
          method: method as "GET",
          url,
          headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...WEB },
          ...(body ? { payload: body as object } : {}),
        });
        expect(asViewerCookie.statusCode, `ll_viewer ${method} ${url}`).toBe(401);
      }
    });

    it("a parent token (bearer or ll_access) on /share/album is 401, with and without the native header", async () => {
      for (const headers of [
        { authorization: `Bearer ${mom.token}` },
        { ...NATIVE, authorization: `Bearer ${mom.token}` },
        { cookie: `ll_access=${mom.token}` },
        { cookie: `${VIEWER_COOKIE}=${mom.token}` },
        { ...NATIVE, authorization: `Bearer ${nanny.token}` },
      ]) {
        const res = await h.app.inject({ method: "GET", url: "/share/album", headers });
        expect(res.statusCode, JSON.stringify(Object.keys(headers))).toBe(401);
        const pp = await h.app.inject({ method: "GET", url: "/share/photos", headers });
        expect(pp.statusCode).toBe(401);
      }
      // the exchange does not turn a parent session into a viewer one either
      const res = await h.app.inject({
        method: "POST",
        url: "/share/session",
        headers: { ...WEB, authorization: `Bearer ${mom.token}`, "cf-connecting-ip": newIp() },
        payload: { token: "C".repeat(22) },
      });
      expect(res.statusCode).toBe(410);
    });

    it("a forged viewer JWT (wrong key, or a jti that is not a session) cannot read anything", async () => {
      const cookie = await open(album);
      const [h64, p64] = cookie.split(".") as [string, string];
      const tampered = `${h64}.${p64}.${"A".repeat(43)}`;
      expect((await vget(tampered, "/share/album")).statusCode).toBe(401);
      // a correctly signed token whose jti was never a session: 410 (session check), not data
      const { mintViewerJwt } = await import("./crypto");
      const fake = await mintViewerJwt(h.config, {
        shareLinkId: album.id,
        sessionId: randomUUID(),
        linkExpiresAt: new Date(Date.now() + 3600_000),
      });
      expectExpired(await vget(fake.token, "/share/album"));
      expectExpired(await vget(fake.token, "/share/photos"));
    });

    it("a session cookie of link A cannot be pointed at link B (claims share_link_id must match the session)", async () => {
      const { mintViewerJwt } = await import("./crypto");
      const cookieA = await open(album);
      const claimsA = JSON.parse(
        Buffer.from(cookieA.split(".")[1] as string, "base64url").toString(),
      );
      const forged = await mintViewerJwt(h.config, {
        shareLinkId: other.id, // B's id with A's session id
        sessionId: claimsA.jti,
        linkExpiresAt: new Date(Date.now() + 3600_000),
      });
      const res = await vget(forged.token, "/share/photos");
      expectExpired(res);
    });

    it("a stranger or contributor admin session cannot reach viewer data by sending ids", async () => {
      for (const u of [stranger, nanny]) {
        const res = await h.app.inject({
          method: "POST",
          url: "/share/photos/urls",
          headers: { ...u.headers, ...WEB },
          payload: { ids: [ph.a], kind: "thumb" },
        });
        expect(res.statusCode).toBe(401);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("manifest", () => {
    it("echoes start_url for a valid token shape, public and uncached; an invalid shape is 400", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: `/share/manifest.webmanifest?t=${album.token}`,
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"])).toMatch(/application\/manifest\+json/);
      expect(res.headers["cache-control"]).toBe("no-store");
      const m = JSON.parse(res.body);
      expect(m.start_url).toBe(`/s/${album.token}`);
      expect(m.scope).toBe("/s/");
      expect(res.body).not.toContain(BABY_NAME);
      expect(res.body).not.toContain(LINK_NAME);
      for (const t of ["short", "<script>", "a/b/c/d/e/f/g/h/i/j/k/l/m", "x".repeat(70), ""]) {
        const bad = await h.app.inject({
          method: "GET",
          url: `/share/manifest.webmanifest?t=${encodeURIComponent(t)}`,
        });
        expect(bad.statusCode, t).toBe(400);
      }
      expect(
        (await h.app.inject({ method: "GET", url: "/share/manifest.webmanifest" })).statusCode,
      ).toBe(400);
    });

    it("answers for an unknown but well-formed token without touching the database (no oracle)", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: `/share/manifest.webmanifest?t=${"Z".repeat(22)}`,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("privacy: logs and audit", () => {
    it("the captured API log never contains a token, passcode, JWT, IP, signature, URL or name", async () => {
      logLines.length = 0;
      const link = await createLink({ passcode: PASSCODE, allowDownload: true });
      await addPhotos(link, [ph.a, ph.sens] as string[]);
      // wrong code, right code, manifest with ?t=, photo list, urls, download, expiry, sign-out
      await exchange(link.token, { ip: SENTINEL_IP, passcode: "999999" });
      await exchange(link.token, { ip: SENTINEL_IP });
      const ok = await exchange(link.token, { ip: SENTINEL_IP, passcode: PASSCODE });
      const cookie = cookieValue(ok) as string;
      const photos = viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json());
      const urls = viewerUrlsResponseSchema.parse(
        (await vpost(cookie, "/share/photos/urls", { ids: [ph.a], kind: "display" })).json(),
      );
      const dlRes = viewerDownloadResponseSchema.parse(
        (await vpost(cookie, `/share/photos/${ph.a}/download`)).json(),
      );
      await h.app.inject({ method: "GET", url: `/share/manifest.webmanifest?t=${link.token}` });
      await exchange("D".repeat(22), { ip: SENTINEL_IP });
      await vpost(cookie, "/share/photos/urls", { ids: ["bad"], kind: "thumb" }); // a 400
      await setLinkSql(link.id, "expires_at = now() - interval '1 minute'");
      await vget(cookie, "/share/album"); // a 410
      await h.app.inject({
        method: "DELETE",
        url: "/share/session",
        headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...WEB },
      });
      const text = logLines.join("\n");
      expect(text.length).toBeGreaterThan(0);
      const secrets = [
        link.token,
        hashShareToken(link.token).toString("hex"),
        hashShareToken(link.token).toString("base64"),
        PASSCODE,
        "999999",
        cookie,
        cookie.split(".")[2] as string,
        SENTINEL_IP,
        hashClientIp(h.config, SENTINEL_IP).toString("hex"),
        LINK_NAME,
        BABY_NAME,
        "scrypt$",
        ...photos.photos.flatMap((p) => (p.thumbUrl ? [p.thumbUrl] : [])),
        ...urls.urls.map((u) => u.url),
        dlRes.url,
      ];
      // Numeric secrets must not match inside timestamps or durations.
      const found = (secret: string) =>
        /^\d+$/.test(secret)
          ? new RegExp(`(?<![\\d.])${secret}(?![\\d])`).test(text)
          : text.includes(secret);
      for (const secret of secrets) expect(found(secret), secret.slice(0, 30)).toBe(false);
      expect(text).not.toMatch(/X-Amz-Signature|X-Amz-Credential|ll_viewer=/i);
      expect(text).not.toMatch(/derivatives\//);
    });

    it("audit rows of viewer activity carry no secrets and no actor", async () => {
      const { rows } = await h.admin.query(
        `SELECT event, actor_user_id, metadata FROM public.audit_log
          WHERE baby_id = $1 AND event LIKE 'share_link.%'`,
        [baby],
      );
      expect(rows.length).toBeGreaterThan(0);
      const text = JSON.stringify(rows);
      for (const secret of [PASSCODE, SENTINEL_IP, LINK_NAME, BABY_NAME, "scrypt", "ll_viewer"]) {
        expect(text, secret).not.toContain(secret);
      }
      for (const r of rows) {
        if (r.event === "share_link.passcode_locked") expect(r.actor_user_id).toBeNull();
      }
    });
  });
});
