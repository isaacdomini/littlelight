import {
  SHARE_VIDEO_URL_TTL_SEC,
  shareLinkCreatedResponseSchema,
  VIEWER_COOKIE,
  viewerDownloadResponseSchema,
  viewerPhotosResponseSchema,
  viewerUrlsResponseSchema,
} from "@tinyglow/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";

// Share-link viewer and videos (docs/plans/step-12.md 2.5, Q9; 12.10): the viewer payload carries
// `mediaKind`/`durationMs`, `POST /share/photos/urls` with `kind: "web"` signs the rendition for
// the link's video rows only (never a photo's stray web row, never a hidden sensitive video,
// never another link's video, longer TTL, video/mp4), the download is the MP4 rendition and never
// the original, and a sensitive video is blurred/hidden exactly like a photo.

const WEB = { "x-tinyglow-client": "web" };

describe.skipIf(!databaseUrl)("share-link viewer: videos", () => {
  let h: Harness;
  let mom: TestUser;
  let baby: string;
  let otherBaby: string;
  const ph: Record<string, string> = {};
  let ipCounter = 0;
  const newIp = () => {
    ipCounter = (ipCounter % 150) + 1;
    return `198.51.100.${ipCounter}`;
  };

  interface Link {
    id: string;
    token: string;
  }
  async function createLink(body: Record<string, unknown> = {}, babyId = baby): Promise<Link> {
    const res = await h.inject(mom, "POST", `/babies/${babyId}/share-links`, {
      name: "Family",
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = shareLinkCreatedResponseSchema.parse(res.json());
    return { id: created.link.id, token: created.url.split("/s/")[1] as string };
  }
  const addPhotos = async (link: Link, ids: string[], showSensitive = false) => {
    const res = await h.inject(mom, "POST", `/share-links/${link.id}/photos`, {
      photoIds: ids,
      showSensitive,
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  async function open(link: Link): Promise<string> {
    const res = await h.app.inject({
      method: "POST",
      url: "/share/session",
      headers: { ...WEB, "cf-connecting-ip": newIp(), "user-agent": "Mozilla/5.0 Safari/604.1" },
      payload: { token: link.token },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.cookies.find((c) => c.name === VIEWER_COOKIE)?.value as string;
  }
  const vget = (cookie: string, url: string) =>
    h.app.inject({ method: "GET", url, headers: { cookie: `${VIEWER_COOKIE}=${cookie}` } });
  const vpost = (cookie: string, url: string, body: unknown = {}) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { cookie: `${VIEWER_COOKIE}=${cookie}`, ...WEB },
      payload: body as object,
    });
  const urlsOf = (res: LightMyRequestResponse) => viewerUrlsResponseSchema.parse(res.json()).urls;

  let album: Link; // video + photo + sensitive video; downloads off
  let dl: Link; // video + photo; downloads on
  let other: Link; // another baby's video

  beforeAll(async () => {
    h = await createHarness();
    mom = await h.user();
    const stranger = await h.user();
    baby = await h.baby(mom, "Vee");
    otherBaby = await h.baby(stranger, "Other");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = ANY($1::uuid[])", [
      [baby, otherBaby],
    ]);
    const common = { uploadedBy: mom.id, withThumb: true, withDisplay: true, withAnalysis: true };
    ph.video = await seedPhoto(h.admin, baby, {
      ...common,
      mediaKind: "video",
      durationMs: 42_000,
      withWeb: true,
      withKeyframes: true,
      takenAt: "2026-06-10T10:00:00Z",
    });
    ph.photo = await seedPhoto(h.admin, baby, { ...common, takenAt: "2026-06-11T10:00:00Z" });
    // a photo with a stray `web` derivative row: the policy, not just the api, must hide it
    await h.admin.query(
      "INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'web', $2, 10, 10, 10)",
      [ph.photo, `babies/${baby}/derivatives/${ph.photo}/web.mp4`],
    );
    ph.sensVideo = await seedPhoto(h.admin, baby, {
      ...common,
      mediaKind: "video",
      durationMs: 9000,
      withWeb: true,
      takenAt: "2026-06-12T10:00:00Z",
    });
    await h.admin.query("UPDATE public.photos SET is_sensitive = true WHERE id = $1", [
      ph.sensVideo,
    ]);
    ph.pendingVideo = await seedPhoto(h.admin, baby, {
      ...common,
      mediaKind: "video",
      renditionStatus: "pending",
      takenAt: "2026-06-13T10:00:00Z",
    });
    ph.foreignVideo = await seedPhoto(h.admin, otherBaby, {
      uploadedBy: stranger.id,
      withThumb: true,
      withDisplay: true,
      mediaKind: "video",
      withWeb: true,
    });
    album = await createLink();
    await addPhotos(album, [ph.video, ph.photo, ph.sensVideo, ph.pendingVideo] as string[]);
    dl = await createLink({ allowDownload: true });
    await addPhotos(dl, [ph.video, ph.photo] as string[]);
    // the other baby's link, created by its own admin
    const res = await h.inject(stranger, "POST", `/babies/${otherBaby}/share-links`, {
      name: "Other",
    });
    const created = shareLinkCreatedResponseSchema.parse(res.json());
    other = { id: created.link.id, token: created.url.split("/s/")[1] as string };
    const add = await h.inject(stranger, "POST", `/share-links/${other.id}/photos`, {
      photoIds: [ph.foreignVideo],
    });
    expect(add.statusCode, add.body).toBe(200);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("the viewer payload carries mediaKind and durationMs; the hidden sensitive video has no URL and no duration leak", async () => {
    const cookie = await open(album);
    const res = await vget(cookie, "/share/photos");
    expect(res.statusCode, res.body).toBe(200);
    const body = viewerPhotosResponseSchema.parse(res.json());
    const byId = new Map(body.photos.map((p) => [p.id, p]));
    expect(byId.get(ph.video as string)).toMatchObject({
      mediaKind: "video",
      durationMs: 42_000,
      hidden: false,
    });
    expect(byId.get(ph.photo as string)).toMatchObject({ mediaKind: "photo", durationMs: null });
    expect(byId.get(ph.pendingVideo as string)).toMatchObject({ mediaKind: "video" });
    const sens = byId.get(ph.sensVideo as string);
    expect(sens?.hidden).toBe(true);
    expect(sens?.thumbUrl).toBeNull();
    // never any storage key, original path or codec detail
    expect(res.body).not.toMatch(/originals|video_codec|videoCodec|storage_key/);
  });

  it("urls kind web: signed video/mp4 URLs for the link's video rows only, with the long TTL", async () => {
    const cookie = await open(album);
    const res = await vpost(cookie, "/share/photos/urls", {
      ids: [ph.video, ph.photo, ph.sensVideo, ph.pendingVideo, ph.foreignVideo],
      kind: "web",
    });
    expect(res.statusCode, res.body).toBe(200);
    const urls = urlsOf(res);
    expect(urls.map((u) => u.id)).toEqual([ph.video]);
    const u = urls[0] as { url: string; expiresAt: string };
    expect(u.url).toMatch(new RegExp(`derivatives/${ph.video}/web\\.mp4`));
    expect(u.url).not.toMatch(/originals/);
    expect(u.url).toMatch(/video%2Fmp4|video\/mp4/);
    const ttl = (Date.parse(u.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(SHARE_VIDEO_URL_TTL_SEC - 120);
    expect(ttl).toBeLessThanOrEqual(SHARE_VIDEO_URL_TTL_SEC + 5);
    // thumb/display (poster frames) still work for the video and the photo, never for the hidden one
    const thumbs = urlsOf(
      await vpost(cookie, "/share/photos/urls", {
        ids: [ph.video, ph.photo, ph.sensVideo],
        kind: "thumb",
      }),
    );
    expect(thumbs.map((t) => t.id).sort()).toEqual([ph.photo, ph.video].sort());
  });

  it("a photo's stray web row is never signed, and the other link's video is not reachable through this one", async () => {
    const cookie = await open(album);
    expect(
      urlsOf(await vpost(cookie, "/share/photos/urls", { ids: [ph.photo], kind: "web" })),
    ).toEqual([]);
    expect(
      urlsOf(await vpost(cookie, "/share/photos/urls", { ids: [ph.foreignVideo], kind: "web" })),
    ).toEqual([]);
    const otherCookie = await open(other);
    const theirs = urlsOf(
      await vpost(otherCookie, "/share/photos/urls", {
        ids: [ph.foreignVideo, ph.video],
        kind: "web",
      }),
    );
    expect(theirs.map((t) => t.id)).toEqual([ph.foreignVideo]);
  });

  it("an unknown kind is a 400; the rendition of a pending video has no URL yet", async () => {
    const cookie = await open(album);
    expect(
      (await vpost(cookie, "/share/photos/urls", { ids: [ph.video], kind: "original" })).statusCode,
    ).toBe(400);
    expect(
      (await vpost(cookie, "/share/photos/urls", { ids: [ph.video], kind: "keyframe1" }))
        .statusCode,
    ).toBe(400);
    expect(
      urlsOf(await vpost(cookie, "/share/photos/urls", { ids: [ph.pendingVideo], kind: "web" })),
    ).toEqual([]);
  });

  it("download: the MP4 rendition with an attachment .mp4 disposition when allowed; never the original; 403 when downloads are off", async () => {
    const off = await open(album);
    const refused = await vpost(off, `/share/photos/${ph.video}/download`);
    expect(refused.statusCode).toBe(403);
    const cookie = await open(dl);
    const res = await vpost(cookie, `/share/photos/${ph.video}/download`);
    expect(res.statusCode, res.body).toBe(200);
    const body = viewerDownloadResponseSchema.parse(res.json());
    expect(body.url).toMatch(/web\.mp4/);
    expect(body.url).not.toMatch(/originals/);
    expect(decodeURIComponent(body.url)).toMatch(/attachment; filename="[^"]+\.mp4"/);
    const photo = viewerDownloadResponseSchema.parse(
      (await vpost(cookie, `/share/photos/${ph.photo}/download`)).json(),
    );
    expect(decodeURIComponent(photo.url)).toMatch(/\.jpg"/);
    expect(photo.url).toMatch(/display\.jpg/);
    // a video not on this link: not shared
    const foreign = await vpost(cookie, `/share/photos/${ph.foreignVideo}/download`);
    expect([403, 404]).toContain(foreign.statusCode);
  });

  it("a sensitive video is never rule-shared and stays hidden until released, like a photo", async () => {
    const rule = await createLink({ rule: { mode: "all", tags: [] } }).catch(() => null);
    if (rule) {
      const rows = await h.admin.query(
        "SELECT 1 FROM public.shared_photos WHERE share_link_id = $1 AND photo_id = $2 AND added_by = 'rule'",
        [rule.id, ph.sensVideo],
      );
      expect(rows.rows).toHaveLength(0);
    }
    // released by hand: visible with its URLs
    await addPhotos(dl, [ph.sensVideo] as string[], true);
    const cookie = await open(dl);
    const body = viewerPhotosResponseSchema.parse((await vget(cookie, "/share/photos")).json());
    const sens = body.photos.find((p) => p.id === ph.sensVideo);
    expect(sens?.hidden).toBe(false);
    expect(sens?.mediaKind).toBe("video");
    expect(
      urlsOf(await vpost(cookie, "/share/photos/urls", { ids: [ph.sensVideo], kind: "web" })).map(
        (u) => u.id,
      ),
    ).toEqual([ph.sensVideo]);
  });
});
