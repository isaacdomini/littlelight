import { apiErrorSchema, FREE_TIER_PHOTO_LIMIT } from "@tinyglow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedManyPhotos, seedPhoto } from "../testing/photos";

// The family pool at the HTTP edge (docs/plans/step-11.md 2.2 B/C, 2.5; PRD FR-5.8 "The free tier
// (up to 1,000 photos)", FR-2.7): approving a guest's photo into a full family is refused
// atomically by the trigger (409 free_tier_limit, the photo stays pending), restore only checks
// the pool for approved photos, and pending photos count for nothing until approved. Every case
// has its own parent, so each family starts empty.

describe.skipIf(!databaseUrl)("family pool: approve and restore (api + db)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function family() {
    const mom = await h.user();
    const baby = await h.baby(mom);
    const guest = await h.user();
    await h.member(baby, guest, "contributor");
    return { mom, baby, guest };
  }
  const state = async (id: string) =>
    (
      await h.admin.query(
        "SELECT approval, deleted_at, approved_by FROM public.photos WHERE id = $1",
        [id],
      )
    ).rows[0] as { approval: string; deleted_at: Date | null; approved_by: string | null };
  const pool = async (u: TestUser, baby: string) =>
    (await h.inject(u, "GET", `/babies/${baby}`)).json().freeTier as {
      used: number;
      familyAlbums: number;
    };

  describe("approve", () => {
    it("into a full family is 409 free_tier_limit; the photo stays pending; after a trash it succeeds", async () => {
      const { mom, baby, guest } = await family();
      await seedManyPhotos(h.admin, baby, FREE_TIER_PHOTO_LIMIT);
      const pending = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      const r = await h.inject(mom, "POST", `/photos/${pending}/approve`);
      expect(r.statusCode).toBe(409);
      const body = apiErrorSchema.parse(r.json());
      expect(body.error).toBe("free_tier_limit");
      expect(body.message).toBe(
        "Your family's free albums are full: free albums hold 1,000 photos per family. Upgrade to Plus or delete photos to add more.",
      );
      expect(await state(pending)).toMatchObject({ approval: "pending", approved_by: null });
      expect((await pool(mom, baby)).used).toBe(FREE_TIER_PHOTO_LIMIT);
      expect(await h.audit({ event: "photo.approved", actor: mom.id })).toHaveLength(0);

      // trash one approved photo: the approval then goes through and the pool is full again
      await h.admin.query(
        "UPDATE public.photos SET deleted_at = now() WHERE id = (SELECT id FROM public.photos WHERE baby_id = $1 AND approval = 'approved' AND deleted_at IS NULL LIMIT 1)",
        [baby],
      );
      const ok = await h.inject(mom, "POST", `/photos/${pending}/approve`);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await state(pending)).toMatchObject({ approval: "approved", approved_by: mom.id });
      expect((await pool(mom, baby)).used).toBe(FREE_TIER_PHOTO_LIMIT);
    });

    it("the family's other free album counts: a full sibling blocks approval here", async () => {
      const { mom, baby, guest } = await family();
      const sibling = await h.baby(mom, "Twin");
      await seedManyPhotos(h.admin, sibling, FREE_TIER_PHOTO_LIMIT);
      const pending = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      const r = await h.inject(mom, "POST", `/photos/${pending}/approve`);
      expect(r.statusCode).toBe(409);
      expect(apiErrorSchema.parse(r.json()).error).toBe("free_tier_limit");
      // Plus siblings and other families are outside this pool
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [sibling]);
      expect((await h.inject(mom, "POST", `/photos/${pending}/approve`)).statusCode).toBe(200);
    });

    it("a Plus album approves freely past 1,000", async () => {
      const { mom, baby, guest } = await family();
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby]);
      await seedManyPhotos(h.admin, baby, FREE_TIER_PHOTO_LIMIT + 3);
      const pending = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      expect((await h.inject(mom, "POST", `/photos/${pending}/approve`)).statusCode).toBe(200);
    });

    it("pending photos never count: 1,000 of them leave room, and approving them one by one stops at the cap", async () => {
      const { mom, baby, guest } = await family();
      await seedManyPhotos(h.admin, baby, FREE_TIER_PHOTO_LIMIT - 1);
      const a = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      const b = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      expect((await pool(mom, baby)).used).toBe(FREE_TIER_PHOTO_LIMIT - 1);
      expect((await h.inject(mom, "POST", `/photos/${a}/approve`)).statusCode).toBe(200);
      const second = await h.inject(mom, "POST", `/photos/${b}/approve`);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("free_tier_limit");
    });

    it("two admins approving the last free slot at once: one 200, one 409", async () => {
      const { mom, baby, guest } = await family();
      const dad = await h.user();
      await h.member(baby, dad, "admin");
      await seedManyPhotos(h.admin, baby, FREE_TIER_PHOTO_LIMIT - 1);
      const a = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      const b = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      const [r1, r2] = await Promise.all([
        h.inject(mom, "POST", `/photos/${a}/approve`),
        h.inject(dad, "POST", `/photos/${b}/approve`),
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
      expect((await pool(mom, baby)).used).toBe(FREE_TIER_PHOTO_LIMIT);
    });

    it("a guest cannot approve their own photo even when there is room (403), and nothing changes", async () => {
      const { baby, guest } = await family();
      const pending = await seedPhoto(h.admin, baby, { uploadedBy: guest.id, approval: "pending" });
      expect((await h.inject(guest, "POST", `/photos/${pending}/approve`)).statusCode).toBe(403);
      expect((await state(pending)).approval).toBe("pending");
    });
  });

  describe("restore", () => {
    it("an approved photo is refused at the cap; a rejected one returns to the queue without drawing from the pool", async () => {
      const { mom, baby, guest } = await family();
      const trashedApproved = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        trashedAgo: "1 hour",
      });
      const rejected = await seedPhoto(h.admin, baby, {
        uploadedBy: guest.id,
        approval: "rejected",
        trashedAgo: "1 hour",
      });
      await seedManyPhotos(h.admin, baby, FREE_TIER_PHOTO_LIMIT);

      const refused = await h.inject(mom, "POST", `/photos/${trashedApproved}/restore`);
      expect(refused.statusCode).toBe(409);
      expect(apiErrorSchema.parse(refused.json()).error).toBe("free_tier_limit");
      expect((await state(trashedApproved)).deleted_at).not.toBeNull();

      const back = await h.inject(mom, "POST", `/photos/${rejected}/restore`);
      expect(back.statusCode, back.body).toBe(200);
      expect(await state(rejected)).toMatchObject({ approval: "pending", deleted_at: null });
      expect((await pool(mom, baby)).used).toBe(FREE_TIER_PHOTO_LIMIT);
    });

    it("a rejected photo whose uploader's queue is full is 409 pending_limit; the photo stays in the trash", async () => {
      const { mom, baby, guest } = await family();
      const rejected = await seedPhoto(h.admin, baby, {
        uploadedBy: guest.id,
        approval: "rejected",
        trashedAgo: "1 hour",
      });
      await h.admin.query(
        `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, status, approval)
         SELECT $1::uuid, $2::uuid, 'pend/' || gen_random_uuid()::text, 'ingested', 'pending' FROM generate_series(1, 200)`,
        [baby, guest.id],
      );
      const r = await h.inject(mom, "POST", `/photos/${rejected}/restore`);
      expect(r.statusCode).toBe(409);
      expect(apiErrorSchema.parse(r.json()).error).toBe("pending_limit");
      expect((await state(rejected)).deleted_at).not.toBeNull();
    });

    it("a trashed approved photo of a Plus album restores past 1,000", async () => {
      const { mom, baby } = await family();
      await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby]);
      await seedManyPhotos(h.admin, baby, FREE_TIER_PHOTO_LIMIT + 1);
      const t = await seedPhoto(h.admin, baby, { uploadedBy: mom.id, trashedAgo: "1 hour" });
      expect((await h.inject(mom, "POST", `/photos/${t}/restore`)).statusCode).toBe(200);
    });
  });
});
