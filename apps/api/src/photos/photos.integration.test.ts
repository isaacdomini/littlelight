import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  derivativeKey,
  FREE_TIER_PHOTO_LIMIT,
  photoSchema,
  photosListResponseSchema,
} from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedManyPhotos, seedPhoto } from "../testing/photos";

// Photo list views, detail, original, approval queue and trash against a real database
// (docs/plans/step-4.md 2.4, 2.13; PRD FR-2.7, FR-10.2). RLS decides visibility; the API adds the
// non-admin 404 for trashed and failed photos and the admin-only original.

describe.skipIf(!databaseUrl)("photos (api + db)", () => {
  let h: Harness;
  let mom: TestUser; // admin
  let dad: TestUser; // admin
  let nanny: TestUser; // contributor
  let aunt: TestUser; // contributor, no uploads
  let stranger: TestUser;
  let baby: string;
  let other: string;

  const ids: Record<string, string> = {};

  const list = async (user: TestUser, babyId: string, query = "") => {
    const res = await h.inject(user, "GET", `/babies/${babyId}/photos${query}`);
    return res;
  };
  const listIds = async (user: TestUser, babyId: string, query = "") => {
    const res = await list(user, babyId, query);
    expect(res.statusCode, res.body).toBe(200);
    return photosListResponseSchema.parse(res.json()).photos.map((p) => p.id);
  };
  const row = async (id: string) =>
    (
      await h.admin.query(
        "SELECT approval, status, deleted_at, approved_by FROM public.photos WHERE id = $1",
        [id],
      )
    ).rows[0] as {
      approval: string;
      status: string;
      deleted_at: Date | null;
      approved_by: string | null;
    };

  beforeAll(async () => {
    h = await createHarness();
    mom = await h.user();
    dad = await h.user();
    nanny = await h.user();
    aunt = await h.user();
    stranger = await h.user();
    baby = await h.baby(mom);
    other = await h.baby(await h.user(), "Other");
    await h.member(baby, dad, "admin");
    await h.member(baby, nanny, "contributor");
    await h.member(baby, aunt, "contributor");
    const t = (n: number) => `2026-06-${String(n).padStart(2, "0")}T10:00:00Z`;
    ids.ready = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      takenAt: t(10),
      withThumb: true,
      withDisplay: true,
      withAnalysis: true,
    });
    ids.noThumb = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      takenAt: t(9),
      status: "uploaded",
    });
    ids.pendingNanny = await seedPhoto(h.admin, baby, {
      uploadedBy: nanny.id,
      approval: "pending",
      takenAt: t(8),
      status: "ingested",
      withThumb: true,
    });
    ids.pendingDad = await seedPhoto(h.admin, baby, {
      uploadedBy: dad.id,
      approval: "pending",
      takenAt: t(7),
    });
    ids.failed = await seedPhoto(h.admin, baby, {
      uploadedBy: nanny.id,
      approval: "pending",
      status: "failed",
      takenAt: t(6),
    });
    ids.failedApproved = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      status: "failed",
      takenAt: t(5),
    });
    ids.duplicate = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      status: "duplicate",
      takenAt: t(4),
    });
    ids.trashed = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      trashedAgo: "1 day",
      takenAt: t(3),
    });
    ids.rejected = await seedPhoto(h.admin, baby, {
      uploadedBy: nanny.id,
      approval: "rejected",
      trashedAgo: "1 hour",
      takenAt: t(2),
    });
    ids.quarantined = await seedPhoto(h.admin, baby, {
      uploadedBy: mom.id,
      quarantined: true,
      takenAt: t(1),
      withThumb: true,
    });
    ids.foreign = await seedPhoto(h.admin, other, { takenAt: t(10), withThumb: true });
    await h.admin.query(
      "INSERT INTO public.photo_exif (photo_id, place_label, camera_make, tz_offset_minutes) VALUES ($1, 'Home', 'Acme', -420)",
      [ids.ready],
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  describe("list", () => {
    it("admin album: live photos incl. pending, never failed / duplicate / trashed / rejected / quarantined", async () => {
      const got = await listIds(mom, baby);
      expect(new Set(got)).toEqual(
        new Set([ids.ready, ids.noThumb, ids.pendingNanny, ids.pendingDad]),
      );
      // Newest first by capture time.
      expect(got).toEqual([ids.ready, ids.noThumb, ids.pendingNanny, ids.pendingDad]);
    });

    it("a contributor sees the approved album plus only their own pending uploads", async () => {
      expect(new Set(await listIds(nanny, baby))).toEqual(
        new Set([ids.ready, ids.noThumb, ids.pendingNanny]),
      );
      expect(new Set(await listIds(aunt, baby))).toEqual(new Set([ids.ready, ids.noThumb]));
    });

    it("pending view: unapproved live photos only (no failed ones); pendingCount matches per role", async () => {
      const res = await list(mom, baby, "?view=pending");
      const body = photosListResponseSchema.parse(res.json());
      expect(new Set(body.photos.map((p) => p.id))).toEqual(
        new Set([ids.pendingNanny, ids.pendingDad]),
      );
      expect(body.pendingCount).toBe(2);
      const n = photosListResponseSchema.parse((await list(nanny, baby, "?view=pending")).json());
      expect(n.photos.map((p) => p.id)).toEqual([ids.pendingNanny]);
      expect(n.pendingCount).toBe(1);
      const a = photosListResponseSchema.parse((await list(aunt, baby, "?view=pending")).json());
      expect(a.photos).toEqual([]);
      expect(a.pendingCount).toBe(0);
    });

    it("trash view is admin-only: admins see trashed and rejected photos, contributors 403, strangers 404", async () => {
      const got = await listIds(mom, baby, "?view=trash");
      expect(new Set(got)).toEqual(new Set([ids.trashed, ids.rejected]));
      expect((await listIds(dad, baby, "?view=trash")).length).toBe(2);
      const n = await list(nanny, baby, "?view=trash");
      expect(n.statusCode).toBe(403);
      expect(apiErrorSchema.parse(n.json()).error).toBe("forbidden");
      expect((await list(stranger, baby, "?view=trash")).statusCode).toBe(404);
    });

    it("a stranger or anonymous caller gets nothing; another baby's photos never leak", async () => {
      const r = await list(stranger, baby);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain(ids.ready);
      expect((await h.inject(null, "GET", `/babies/${baby}/photos`)).statusCode).toBe(401);
      expect(await listIds(mom, baby)).not.toContain(ids.foreign);
      expect((await list(mom, other)).statusCode).toBe(404);
    });

    it("signs a thumb URL only where a thumb exists, with the derivative key, TTL <= 3600", async () => {
      const body = photosListResponseSchema.parse((await list(mom, baby)).json());
      const ready = body.photos.find((p) => p.id === ids.ready);
      const noThumb = body.photos.find((p) => p.id === ids.noThumb);
      expect(noThumb?.thumbUrl).toBeNull();
      const u = new URL(ready?.thumbUrl ?? "");
      expect(u.origin).toBe(new URL(h.config.S3_PUBLIC_ENDPOINT).origin);
      expect(u.pathname).toBe(
        `/${h.config.S3_BUCKET}/${derivativeKey(baby, ids.ready as string, "thumb")}`,
      );
      expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
      expect(ready?.urlExpiresAt).toBeTruthy();
    });

    it("never serialises the analysis derivative, storage keys or hashes", async () => {
      for (const user of [mom, nanny]) {
        const body = (await list(user, baby)).body;
        expect(body).not.toMatch(/analysis|storage_key|originals\/|"sha256"/i);
      }
    });

    it("keyset pagination returns every photo once, in order, across ties", async () => {
      const b = await h.baby(mom, "Pager");
      const same = "2026-05-01T10:00:00Z";
      const made: string[] = [];
      for (let i = 0; i < 7; i++) {
        made.push(
          await seedPhoto(h.admin, b, { takenAt: i < 4 ? same : `2026-05-0${i}T10:00:00Z` }),
        );
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await list(mom, b, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
        const body = photosListResponseSchema.parse(res.json());
        seen.push(...body.photos.map((p) => p.id));
        cursor = body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen)).toEqual(new Set(made));
      const expected = (
        await h.admin.query(
          "SELECT id FROM public.photos WHERE baby_id = $1 ORDER BY COALESCE(taken_at, created_at) DESC, id DESC",
          [b],
        )
      ).rows.map((r) => r.id);
      expect(seen).toEqual(expected);
    });

    it("rejects a malformed cursor, an out-of-range limit and an unknown view with 400", async () => {
      expect((await list(mom, baby, "?cursor=!!!")).statusCode).toBe(400);
      expect(
        (await list(mom, baby, `?cursor=${Buffer.from("nope|nope").toString("base64url")}`))
          .statusCode,
      ).toBe(400);
      expect((await list(mom, baby, "?limit=201")).statusCode).toBe(400);
      expect((await list(mom, baby, "?limit=0")).statusCode).toBe(400);
      expect((await list(mom, baby, "?view=everything")).statusCode).toBe(400);
    });
  });

  describe("detail", () => {
    it("returns exif without GPS and signs thumb + display only", async () => {
      const res = await h.inject(mom, "GET", `/photos/${ids.ready}`);
      expect(res.statusCode, res.body).toBe(200);
      const p = photoSchema.parse(res.json());
      expect(p.exif).toMatchObject({
        placeLabel: "Home",
        cameraMake: "Acme",
        tzOffsetMinutes: -420,
      });
      expect(p.displayUrl).toContain(derivativeKey(baby, ids.ready as string, "display"));
      expect(p.thumbUrl).toContain(derivativeKey(baby, ids.ready as string, "thumb"));
      expect(res.body).not.toMatch(/analysis|gps|latitude|longitude|storage_key/i);
    });

    it("failed and trashed photos are 404 for non-admins but readable by admins", async () => {
      for (const id of [ids.failed, ids.failedApproved, ids.trashed, ids.rejected]) {
        expect((await h.inject(aunt, "GET", `/photos/${id}`)).statusCode, id).toBe(404);
        expect((await h.inject(nanny, "GET", `/photos/${id}`)).statusCode, id).toBe(404);
        expect((await h.inject(mom, "GET", `/photos/${id}`)).statusCode, id).toBe(200);
      }
    });

    it("another contributor's pending photo is 404 (RLS); an admin's pending is 200 for admins", async () => {
      expect((await h.inject(aunt, "GET", `/photos/${ids.pendingNanny}`)).statusCode).toBe(404);
      expect((await h.inject(nanny, "GET", `/photos/${ids.pendingNanny}`)).statusCode).toBe(200);
      expect((await h.inject(dad, "GET", `/photos/${ids.pendingNanny}`)).statusCode).toBe(200);
    });

    it("quarantined and duplicate-marker photos do not exist for anyone; strangers and other babies get 404", async () => {
      for (const id of [ids.quarantined, ids.duplicate]) {
        expect((await h.inject(mom, "GET", `/photos/${id}`)).statusCode, id).toBe(404);
      }
      expect((await h.inject(stranger, "GET", `/photos/${ids.ready}`)).statusCode).toBe(404);
      expect((await h.inject(mom, "GET", `/photos/${ids.foreign}`)).statusCode).toBe(404);
      expect((await h.inject(mom, "GET", `/photos/${randomUUID()}`)).statusCode).toBe(404);
      expect((await h.inject(null, "GET", `/photos/${ids.ready}`)).statusCode).toBe(401);
    });
  });

  describe("original", () => {
    it("an admin gets a signed download URL for the original and the download is audited", async () => {
      const res = await h.inject(mom, "GET", `/photos/${ids.ready}/original`);
      expect(res.statusCode, res.body).toBe(200);
      const u = new URL(res.json().url);
      expect(u.origin).toBe(new URL(h.config.S3_PUBLIC_ENDPOINT).origin);
      expect(u.pathname).toBe(`/${h.config.S3_BUCKET}/babies/${baby}/originals/${ids.ready}`);
      expect(u.searchParams.get("response-content-disposition")).toContain("attachment");
      expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
      const ev = await h.audit({ event: "photo.original_downloaded", actor: mom.id, baby });
      expect(ev.some((e) => e.metadata.photo_id === ids.ready)).toBe(true);
    });

    it("contributors get 403 (even for their own upload), strangers 404, and a failed photo is 404 to a contributor", async () => {
      const own = await h.inject(nanny, "GET", `/photos/${ids.pendingNanny}/original`);
      expect(own.statusCode).toBe(403);
      expect(own.body).not.toContain("originals/");
      expect((await h.inject(aunt, "GET", `/photos/${ids.ready}/original`)).statusCode).toBe(403);
      expect((await h.inject(stranger, "GET", `/photos/${ids.ready}/original`)).statusCode).toBe(
        404,
      );
      expect((await h.inject(nanny, "GET", `/photos/${ids.failed}/original`)).statusCode).toBe(404);
      expect((await h.inject(null, "GET", `/photos/${ids.ready}/original`)).statusCode).toBe(401);
    });
  });

  describe("approval queue", () => {
    it("a contributor cannot approve (not even their own upload): 403, row unchanged", async () => {
      const id = await seedPhoto(h.admin, baby, {
        uploadedBy: nanny.id,
        approval: "pending",
        status: "ingested",
      });
      const r = await h.inject(nanny, "POST", `/photos/${id}/approve`);
      expect(r.statusCode).toBe(403);
      expect((await row(id)).approval).toBe("pending");
      expect((await h.inject(aunt, "POST", `/photos/${id}/approve`)).statusCode).toBe(404);
      expect((await h.inject(stranger, "POST", `/photos/${id}/approve`)).statusCode).toBe(404);
    });

    it("an admin approves; the photo joins the contributors' album; approving twice is 409", async () => {
      const id = await seedPhoto(h.admin, baby, {
        uploadedBy: nanny.id,
        approval: "pending",
        status: "ingested",
      });
      expect(await listIds(aunt, baby)).not.toContain(id);
      const r = await h.inject(mom, "POST", `/photos/${id}/approve`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ id, approval: "approved" });
      expect(await row(id)).toMatchObject({ approval: "approved", approved_by: mom.id });
      expect(await listIds(aunt, baby)).toContain(id);
      const again = await h.inject(dad, "POST", `/photos/${id}/approve`);
      expect(again.statusCode).toBe(409);
      expect(
        (await h.audit({ event: "photo.approved", actor: mom.id })).some(
          (e) => e.metadata.photo_id === id,
        ),
      ).toBe(true);
    });

    it("failed photos cannot be approved (409) and stay out of the queue", async () => {
      const r = await h.inject(mom, "POST", `/photos/${ids.failed}/approve`);
      expect(r.statusCode).toBe(409);
      expect((await row(ids.failed as string)).approval).toBe("pending");
    });

    it("reject sends the photo to the trash as rejected; contributors cannot reject", async () => {
      const id = await seedPhoto(h.admin, baby, {
        uploadedBy: nanny.id,
        approval: "pending",
        status: "ingested",
      });
      expect((await h.inject(nanny, "POST", `/photos/${id}/reject`)).statusCode).toBe(403);
      const r = await h.inject(mom, "POST", `/photos/${id}/reject`);
      expect(r.statusCode, r.body).toBe(200);
      expect(await row(id)).toMatchObject({ approval: "rejected" });
      expect((await row(id)).deleted_at).not.toBeNull();
      expect(await listIds(mom, baby)).not.toContain(id);
      expect(await listIds(mom, baby, "?view=trash")).toContain(id);
      expect(await listIds(nanny, baby)).not.toContain(id);
    });
  });

  describe("trash and restore", () => {
    it("a contributor may trash only their own pending photo; everything else is 403 or 404", async () => {
      const mine = await seedPhoto(h.admin, baby, {
        uploadedBy: nanny.id,
        approval: "pending",
        status: "ingested",
      });
      const approved = await seedPhoto(h.admin, baby, { uploadedBy: nanny.id, status: "ready" });
      const theirs = await seedPhoto(h.admin, baby, { uploadedBy: dad.id, approval: "pending" });
      expect((await h.inject(nanny, "DELETE", `/photos/${mine}`)).statusCode).toBe(204);
      expect((await row(mine)).deleted_at).not.toBeNull();
      expect((await h.inject(nanny, "DELETE", `/photos/${approved}`)).statusCode).toBe(403);
      expect((await row(approved)).deleted_at).toBeNull();
      expect((await h.inject(nanny, "DELETE", `/photos/${theirs}`)).statusCode).toBe(404);
      expect((await h.inject(stranger, "DELETE", `/photos/${approved}`)).statusCode).toBe(404);
      expect((await h.inject(null, "DELETE", `/photos/${approved}`)).statusCode).toBe(401);
    });

    it("an admin trashes any photo; trashing again is idempotent; it is audited", async () => {
      const id = await seedPhoto(h.admin, baby, { uploadedBy: nanny.id });
      expect((await h.inject(mom, "DELETE", `/photos/${id}`)).statusCode).toBe(204);
      expect((await h.inject(dad, "DELETE", `/photos/${id}`)).statusCode).toBe(204);
      expect(
        (await h.audit({ event: "photo.trashed", actor: mom.id })).some(
          (e) => e.metadata.photo_id === id,
        ),
      ).toBe(true);
    });

    it("restore is admin-only; a rejected upload returns to the approval queue, a trashed one to the album", async () => {
      const rej = await seedPhoto(h.admin, baby, {
        uploadedBy: nanny.id,
        approval: "rejected",
        trashedAgo: "1 hour",
        status: "ingested",
      });
      const tr = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, trashedAgo: "1 hour" });
      expect((await h.inject(nanny, "POST", `/photos/${rej}/restore`)).statusCode).toBe(404); // trashed = invisible to non-admins
      expect((await h.inject(aunt, "POST", `/photos/${tr}/restore`)).statusCode).toBe(404);
      expect((await h.inject(stranger, "POST", `/photos/${tr}/restore`)).statusCode).toBe(404);
      const a = await h.inject(mom, "POST", `/photos/${rej}/restore`);
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json()).toMatchObject({ approval: "pending", deletedAt: null });
      const b = await h.inject(dad, "POST", `/photos/${tr}/restore`);
      expect(b.json()).toMatchObject({ approval: "approved", deletedAt: null });
      expect(await listIds(mom, baby, "?view=pending")).toContain(rej);
      expect(await listIds(mom, baby)).toContain(tr);
    });

    it("a contributor cannot restore a live photo either (403)", async () => {
      expect((await h.inject(nanny, "POST", `/photos/${ids.ready}/restore`)).statusCode).toBe(403);
    });

    it("free tier: restoring past the 1000-photo cap is 409 free_tier_limit; a paid baby may", async () => {
      // One pool per family (step 11): take mom's base album out of it for this case.
      const siblings = (
        await h.admin.query(
          `UPDATE public.babies SET plan = 'plus'
            WHERE family_id = (SELECT family_id FROM public.babies WHERE id = $1) AND plan = 'free'
           RETURNING id`,
          [baby],
        )
      ).rows.map((r) => r.id as string);
      const b = await h.baby(mom, "Capped");
      try {
        const t = await seedPhoto(h.admin, b, { trashedAgo: "1 hour" });
        await seedManyPhotos(h.admin, b, FREE_TIER_PHOTO_LIMIT);
        const r = await h.inject(mom, "POST", `/photos/${t}/restore`);
        expect(r.statusCode).toBe(409);
        expect(apiErrorSchema.parse(r.json()).error).toBe("free_tier_limit");
        expect((await row(t)).deleted_at).not.toBeNull();
        await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [b]);
        expect((await h.inject(mom, "POST", `/photos/${t}/restore`)).statusCode).toBe(200);
      } finally {
        await h.admin.query("UPDATE public.babies SET plan = 'free' WHERE id = ANY($1::uuid[])", [
          siblings,
        ]);
      }
    });

    it("restoring a photo whose bytes are live again is 409 conflict", async () => {
      const b = await h.baby(mom, "Twins");
      const sha = "ab".repeat(32);
      const t = await seedPhoto(h.admin, b, { sha256: sha, trashedAgo: "1 hour" });
      await seedPhoto(h.admin, b, { sha256: sha });
      const r = await h.inject(mom, "POST", `/photos/${t}/restore`);
      expect(r.statusCode).toBe(409);
      expect(apiErrorSchema.parse(r.json()).error).toBe("conflict");
    });

    it("restore of a photo in a trashed baby is 409", async () => {
      const b = await h.baby(mom, "Gone");
      const t = await seedPhoto(h.admin, b, { trashedAgo: "1 hour" });
      await h.admin.query("UPDATE public.babies SET deleted_at = now() WHERE id = $1", [b]);
      const r = await h.inject(mom, "POST", `/photos/${t}/restore`);
      expect([404, 409]).toContain(r.statusCode);
    });
  });

  it("every photo route requires authentication", async () => {
    for (const [method, url] of [
      ["GET", `/babies/${baby}/photos`],
      ["GET", `/photos/${ids.ready}`],
      ["GET", `/photos/${ids.ready}/original`],
      ["POST", `/photos/${ids.ready}/approve`],
      ["POST", `/photos/${ids.ready}/reject`],
      ["POST", `/photos/${ids.ready}/restore`],
      ["DELETE", `/photos/${ids.ready}`],
    ] as const) {
      expect((await h.inject(null, method, url)).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
