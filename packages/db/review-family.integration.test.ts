import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MILESTONE_PRESETS } from "../shared/src/constants";
import {
  provisionReviewFamily,
  REVIEW_PHOTO_COUNT,
  reviewBabyId,
  reviewPhotoId,
} from "./src/review-family";
import { connect, type Db, databaseUrl, ensureMigrated, env } from "./test/harness";

// Store-review family (docs/plans/step-9.md 2.9 item 6, 2.15; D4): provisions a synthetic baby for
// an existing account, idempotently, with the guards that keep it away from real families.

const EMAIL = "review-family-it@tinyglow.test";
const USER = randomUUID();
const OTHER_USER = randomUUID();
const REAL_BABY = randomUUID();

describe.skipIf(!databaseUrl)("review family", () => {
  let db: Db;
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const run = (opts: { confirm?: boolean; email?: string; nodeEnv?: string } = {}) =>
    provisionReviewFamily(
      { email: opts.email ?? EMAIL, confirmProduction: opts.confirm ?? false },
      {
        env: { ...env, ...(opts.nodeEnv ? { NODE_ENV: opts.nodeEnv } : { NODE_ENV: "test" }) },
        databaseUrl,
        log,
      },
    );

  const count = async (sql: string, params: unknown[] = []) =>
    ((await db.admin.query(sql, params)).rows[0]?.n as number) ?? -1;

  async function clean() {
    await db.admin.query("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [
      [reviewBabyId(USER), REAL_BABY],
    ]);
    await db.admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[USER, OTHER_USER]]);
  }

  async function addUser(id: string, email: string, withProfile = true) {
    await db.admin.query(
      "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
      [id, email],
    );
    if (withProfile) {
      await db.admin.query(
        "INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'RF')",
        [id],
      );
    }
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await clean();
  });
  afterAll(async () => {
    if (db) {
      await clean();
      await db.close();
    }
  });
  beforeEach(async () => {
    await clean();
    lines.length = 0;
    await addUser(USER, EMAIL);
  });

  it("creates a plus baby with the account as sole admin, 24 uploaded JPEG photos, details and measurements", async () => {
    const r = await run();
    const babyId = reviewBabyId(USER);
    expect(r).toMatchObject({
      userId: USER,
      babyId,
      babyCreated: true,
      photosCreated: 24,
      measurements: 4,
    });
    expect(r.photoIds).toHaveLength(REVIEW_PHOTO_COUNT);

    const baby = await db.admin.query(
      "SELECT name, plan, plan_owner_user_id, entitlement_expires_at, deleted_at, birth_date FROM public.babies WHERE id = $1",
      [babyId],
    );
    expect(baby.rows[0]).toMatchObject({
      name: "Sunny",
      plan: "plus",
      plan_owner_user_id: USER,
      entitlement_expires_at: null,
      deleted_at: null,
    });
    const members = await db.admin.query(
      "SELECT user_id, role FROM public.baby_members WHERE baby_id = $1",
      [babyId],
    );
    expect(members.rows).toEqual([{ user_id: USER, role: "admin" }]);

    const photos = await db.admin.query(
      "SELECT id, mime, status, approval, storage_key_original AS key, taken_at, age_days FROM public.photos WHERE baby_id = $1 ORDER BY age_days",
      [babyId],
    );
    expect(photos.rows).toHaveLength(24);
    for (const p of photos.rows) {
      expect(p).toMatchObject({ mime: "image/jpeg", status: "uploaded", approval: "approved" });
      expect(p.key).toBe(`babies/${babyId}/originals/${p.id}.jpg`);
      expect(p.taken_at.getTime()).toBeLessThan(Date.now());
    }
    expect(photos.rows.map((p) => p.id).sort()).toEqual(
      Array.from({ length: 24 }, (_, i) => reviewPhotoId(USER, i + 1)).sort(),
    );

    expect(
      await count(
        "SELECT count(*)::int n FROM public.photo_details WHERE photo_id = ANY($1::uuid[])",
        [r.photoIds],
      ),
    ).toBe(r.details);
    expect(r.details).toBe(8);
    expect(
      await count("SELECT count(*)::int n FROM public.measurements WHERE baby_id = $1", [babyId]),
    ).toBe(4);
    const firstSmile = MILESTONE_PRESETS.find((m) => m.name === "First smile");
    expect(firstSmile).toBeDefined();
  });

  it("writes audit rows with a NULL (operator) actor and ids only", async () => {
    await run();
    const a = await db.admin.query(
      "SELECT event, actor_user_id, metadata FROM public.audit_log WHERE baby_id = $1 ORDER BY event",
      [reviewBabyId(USER)],
    );
    expect(a.rows.map((x) => x.event)).toEqual(["baby.created", "baby.plan_changed"]);
    for (const row of a.rows) expect(row.actor_user_id).toBeNull();
    expect(JSON.stringify(a.rows)).not.toContain(EMAIL);
  });

  it("is idempotent: a re-run creates nothing new and adds no audit rows", async () => {
    await run();
    const before = {
      photos: await count("SELECT count(*)::int n FROM public.photos WHERE baby_id = $1", [
        reviewBabyId(USER),
      ]),
      audit: await count("SELECT count(*)::int n FROM public.audit_log WHERE baby_id = $1", [
        reviewBabyId(USER),
      ]),
    };
    const again = await run();
    expect(again).toMatchObject({ babyCreated: false, photosCreated: 0 });
    expect(
      await count("SELECT count(*)::int n FROM public.photos WHERE baby_id = $1", [
        reviewBabyId(USER),
      ]),
    ).toBe(before.photos);
    expect(
      await count("SELECT count(*)::int n FROM public.audit_log WHERE baby_id = $1", [
        reviewBabyId(USER),
      ]),
    ).toBe(before.audit);
    expect(
      await count("SELECT count(*)::int n FROM public.measurements WHERE baby_id = $1", [
        reviewBabyId(USER),
      ]),
    ).toBe(4);
  });

  it("a re-run leaves ingested photos alone but restores a lapsed plan and the admin role", async () => {
    await run();
    const photo = reviewPhotoId(USER, 5);
    await db.admin.query(
      "UPDATE public.photos SET status = 'ready', width = 800, height = 600, bytes = 1000 WHERE id = $1",
      [photo],
    );
    await db.admin
      .query(
        "UPDATE public.babies SET plan = 'free', entitlement_expires_at = now() - interval '1 day' WHERE id = $1",
        [reviewBabyId(USER)],
      )
      .catch(() => undefined);
    const again = await run();
    expect(again.photosCreated).toBe(0);
    const p = await db.admin.query(
      "SELECT status, width, height FROM public.photos WHERE id = $1",
      [photo],
    );
    expect(p.rows[0]).toEqual({ status: "ready", width: 800, height: 600 });
    const b = await db.admin.query(
      "SELECT plan, entitlement_expires_at FROM public.babies WHERE id = $1",
      [reviewBabyId(USER)],
    );
    expect(b.rows[0]).toEqual({ plan: "plus", entitlement_expires_at: null });
  });

  it("output names ids and counts only: never the email", async () => {
    await run();
    const text = lines.join("\n");
    expect(text).toContain(reviewBabyId(USER));
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("Sunny");
  });

  it("refuses production without --confirm-production and does not touch the database", async () => {
    await expect(run({ nodeEnv: "production" })).rejects.toThrow(
      /refusing to provision a review family/,
    );
    expect(
      await count("SELECT count(*)::int n FROM public.babies WHERE id = $1", [reviewBabyId(USER)]),
    ).toBe(0);
  });

  it("refuses an unknown email", async () => {
    await expect(run({ email: "nobody-here@tinyglow.test" })).rejects.toThrow(
      /no GoTrue user with that email/,
    );
  });

  it("refuses an account without a live profile", async () => {
    await db.admin.query("UPDATE public.profiles SET deleted_at = now() WHERE user_id = $1", [
      USER,
    ]);
    await expect(run()).rejects.toThrow(/has no live profile/);
    expect(
      await count("SELECT count(*)::int n FROM public.babies WHERE id = $1", [reviewBabyId(USER)]),
    ).toBe(0);
  });

  describe("an account that already belongs to a real family", () => {
    beforeEach(async () => {
      await addUser(OTHER_USER, "review-family-other@tinyglow.test");
      await db.admin.query(
        "INSERT INTO public.babies (id, name, birth_date, plan) VALUES ($1, 'Real', '2025-01-01', 'free')",
        [REAL_BABY],
      );
      await db.admin.query(
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')",
        [REAL_BABY, USER],
      );
    });

    it("is refused in production (even with --confirm-production) and rolled back", async () => {
      await expect(run({ nodeEnv: "production", confirm: true })).rejects.toThrow(
        /belongs to 1 other baby/,
      );
      expect(
        await count("SELECT count(*)::int n FROM public.babies WHERE id = $1", [
          reviewBabyId(USER),
        ]),
      ).toBe(0);
      expect(
        await count("SELECT count(*)::int n FROM public.photos WHERE baby_id = $1", [
          reviewBabyId(USER),
        ]),
      ).toBe(0);
    });

    it("is allowed outside production with a warning", async () => {
      const r = await run();
      expect(r.otherBabies).toBe(1);
      expect(lines.some((l) => l.includes("warning"))).toBe(true);
    });
  });
});
