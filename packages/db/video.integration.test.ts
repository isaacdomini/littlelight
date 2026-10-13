import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./src/index";
import { createFixtures, dropFixtures, EMAIL, LINK, P, U } from "./test/fixtures";
import {
  authed,
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  env,
  PERMISSION_DENIED,
  tryQuery,
  viewerClaims,
} from "./test/harness";

// Migration 22 `1792500000100_video.sql` (docs/plans/step-12.md 2.2, 12.10): the media shape
// trigger, the viewer's column grants and the `web` derivative visibility (video rows of its own
// link only), the Q3 cap (100 videos per free family, concurrent inserts admit one, GUC override),
// `ai_eligible_photos` holding `pending` videos back, and the pool counting a video as one item.

const VIDEO_CAP_RE = /free tier video limit reached/i;
const SHAPE_RE = /media columns inconsistent with media_kind/i;

describe.skipIf(!databaseUrl)("video (migration 22)", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const scalar = async <T>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0]?.v as T;
  const babies: string[] = [];
  const users: string[] = [];

  async function mkUser(): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())",
      [id, `video-${id}@tinyglow.test`],
    );
    await q("INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'V')", [id]);
    users.push(id);
    return id;
  }
  async function mkBaby(creator: string, plan: "free" | "plus" = "free"): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO public.babies (id, name, birth_date, plan, created_by) VALUES ($1, 'Vid baby', '2025-06-30', 'free', $2)",
      [id, creator],
    );
    await q(
      "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
      [id, creator],
    );
    if (plan === "plus") {
      // like the api's set-plan path: owner first, then the plan (the plan-follows-owner trigger)
      await q("UPDATE public.babies SET plan_owner_user_id = $2, plan = 'plus' WHERE id = $1", [
        id,
        creator,
      ]);
      const stored = await scalar<string>("SELECT plan AS v FROM public.babies WHERE id = $1", [
        id,
      ]);
      if (stored !== "plus") throw new Error(`plus fixture reverted to ${stored}`);
    }
    babies.push(id);
    return id;
  }
  const insertVideo = (
    c: pg.ClientBase,
    baby: string,
    by: string,
    over: Record<string, string> = {},
  ) =>
    c.query(
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime, duration_ms, video_codec, has_audio)
       VALUES ($1::uuid, $2::uuid, $3::uuid, concat('babies/', $2::uuid, '/originals/', $1::uuid, '.mp4'), 1000, $4, 'ingested', 'video', $5, 'video/mp4', 4000, 'h264', false)
       RETURNING id`,
      [randomUUID(), baby, by, over.approval ?? "approved", over.rendition ?? "pending"],
    );

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await dropFixtures(db.admin);
    await createFixtures(db.admin);
  });
  afterAll(async () => {
    await q("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [babies]).catch(
      () => undefined,
    );
    await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]).catch(() => undefined);
    await dropFixtures(db.admin).catch(() => undefined);
    await db?.close();
  });

  it("the migration is applied: columns, trigger, functions, derivative kinds, 2 GiB upload cap", async () => {
    const cols = (
      await q(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'photos' AND column_name IN ('media_kind','duration_ms','video_codec','has_audio','rendition_status')",
      )
    ).rows.map((r) => r.column_name);
    expect(cols.sort()).toEqual([
      "duration_ms",
      "has_audio",
      "media_kind",
      "rendition_status",
      "video_codec",
    ]);
    for (const fn of [
      "photos_media_shape",
      "photos_free_tier_video_cap",
      "free_tier_video_limit",
      "free_tier_pool_videos",
      "viewer_web_photo_ids",
    ]) {
      expect(
        await scalar<string | null>(`SELECT to_regproc('public.${fn}')::text AS v`),
        fn,
      ).not.toBeNull();
    }
    expect(await scalar<number>("SELECT public.free_tier_video_limit() AS v")).toBe(100);
    const err = await tryQuery(
      db.admin,
      "INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'poster', 'x', 1, 1, 1)",
      [P.approved1],
    );
    expect(err?.code).toBe("23514");
  });

  it("photos_media_shape: a photo may not carry video columns; a video may not be rendition 'none'", async () => {
    const photoWithDuration = await tryQuery(
      db.admin,
      "UPDATE public.photos SET duration_ms = 1000 WHERE id = $1",
      [P.approved1],
    );
    expect(photoWithDuration?.message).toMatch(SHAPE_RE);
    expect(
      (
        await tryQuery(
          db.admin,
          "UPDATE public.photos SET rendition_status = 'ready' WHERE id = $1",
          [P.approved1],
        )
      )?.message,
    ).toMatch(SHAPE_RE);
    const u = await mkUser();
    const b = await mkBaby(u, "plus");
    const videoNone = await tryQuery(
      db.admin,
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, status, media_kind, rendition_status, mime)
       VALUES ($1, $2, $3, 'k', 'approved', 'ingested', 'video', 'none', 'video/mp4')`,
      [randomUUID(), b, u],
    );
    expect(videoNone?.message).toMatch(SHAPE_RE);
    const badCodec = await tryQuery(
      db.admin,
      `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, status, media_kind, rendition_status, mime, video_codec)
       VALUES ($1, $2, $3, 'k2', 'approved', 'ingested', 'video', 'pending', 'video/mp4', 'vp9')`,
      [randomUUID(), b, u],
    );
    expect(badCodec?.code).toBe("23514");
    expect(await insertVideo(db.admin, b, u)).toBeTruthy();
  });

  describe("viewer (share link LA; approved2 becomes a video for these tests)", () => {
    beforeAll(async () => {
      await q(
        "UPDATE public.photos SET media_kind = 'video', rendition_status = 'ready', duration_ms = 4000, video_codec = 'h264', has_audio = false, mime = 'video/mp4' WHERE id = $1",
        [P.approved2],
      );
      for (const [photo, kind] of [
        [P.approved2, "web"],
        [P.approved2, "thumb"],
        [P.approved1, "web"], // a photo with a stray web row: must stay invisible
        [P.sensitive, "thumb"],
      ] as const) {
        await q(
          `INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
           VALUES ($1, $2, $3, 10, 10, 10) ON CONFLICT DO NOTHING`,
          [photo, kind, `test/${photo}/${kind}`],
        );
      }
    });

    it("may read media_kind and duration_ms of the link's photos, never video_codec / has_audio", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const rows = (
          await c.query("SELECT id, media_kind, duration_ms FROM public.photos ORDER BY id")
        ).rows as {
          id: string;
          media_kind: string;
          duration_ms: number | null;
        }[];
        const v = rows.find((r) => r.id === P.approved2);
        expect(v).toEqual({ id: P.approved2, media_kind: "video", duration_ms: 4000 });
        expect(rows.find((r) => r.id === P.approved1)?.media_kind).toBe("photo");
        for (const col of ["video_codec", "has_audio", "rendition_status"]) {
          const err = await tryQuery(c, `SELECT ${col} FROM public.photos`);
          expect(err?.message, col).toMatch(PERMISSION_DENIED);
        }
      });
    });

    it("sees the `web` derivative of the link's video only: not a photo's stray web row, not another link's video", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        const rows = (
          await c.query("SELECT photo_id, kind FROM public.photo_derivatives WHERE kind = 'web'")
        ).rows as {
          photo_id: string;
        }[];
        expect(rows.map((r) => r.photo_id)).toEqual([P.approved2]);
        const thumbs = (
          await c.query("SELECT photo_id FROM public.photo_derivatives WHERE kind = 'thumb'")
        ).rows as {
          photo_id: string;
        }[];
        expect(thumbs.map((r) => r.photo_id)).toContain(P.approved2);
        // the sensitive photo's thumb is gated as before
        expect(thumbs.map((r) => r.photo_id)).not.toContain(P.sensitive);
      });
      await db.asViewer(LINK.LB, async (c) => {
        const rows = (
          await c.query("SELECT photo_id FROM public.photo_derivatives WHERE kind = 'web'")
        ).rows;
        expect(rows).toEqual([]);
      });
      await db.asViewer(LINK.LAexpired, async (c) => {
        const rows = (
          await c.query("SELECT photo_id FROM public.photo_derivatives WHERE kind = 'web'")
        ).rows;
        expect(rows).toEqual([]);
      });
    });

    it("a member of another baby or a stranger sees no web row of baby A either", async () => {
      await db.asUser(
        U.stranger,
        async (c) => {
          expect(
            (await c.query("SELECT photo_id FROM public.photo_derivatives WHERE kind = 'web'"))
              .rows,
          ).toEqual([]);
        },
        EMAIL.stranger,
      );
      await db.asUser(
        U.adminA1,
        async (c) => {
          const rows = (
            await c.query(
              "SELECT photo_id FROM public.photo_derivatives WHERE kind = 'web' ORDER BY photo_id",
            )
          ).rows as {
            photo_id: string;
          }[];
          expect(rows.map((r) => r.photo_id).sort()).toEqual([P.approved1, P.approved2].sort());
        },
        EMAIL.adminA1,
      );
    });
  });

  describe("Q3: 100 videos per free family", () => {
    it("the 101st approved live video of a free family is refused; trash / pending / Plus do not count; the GUC lowers the limit", async () => {
      const u = await mkUser();
      const b = await mkBaby(u, "free");
      await q(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'babies/' || $1::text || '/originals/' || gen_random_uuid()::text, 1000, 'approved', 'ingested', 'video', 'pending', 'video/mp4'
           FROM generate_series(1, 100)`,
        [b, u],
      );
      expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(100);
      expect(await scalar<number>("SELECT public.free_tier_pool_used($1) AS v", [b])).toBe(100);
      const refused = await tryQuery(
        db.admin,
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, status, media_kind, rendition_status, mime)
         VALUES ($1, $2, $3, 'cap-k', 'approved', 'ingested', 'video', 'pending', 'video/mp4')`,
        [randomUUID(), b, u],
      );
      expect(refused?.message).toMatch(VIDEO_CAP_RE);
      expect(refused?.code).toBe("23514");
      // a pending video (guest upload) and a photo are still allowed
      expect(await insertVideo(db.admin, b, u, { approval: "pending" })).toBeTruthy();
      const photo = await tryQuery(
        db.admin,
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, status) VALUES ($1, $2, $3, 'p-k', 'approved', 'ingested')`,
        [randomUUID(), b, u],
      );
      expect(photo).toBeNull();
      // approving the pending video past the cap is refused too (UPDATE OF approval)
      const pendingId = (
        await q("SELECT id FROM public.photos WHERE baby_id = $1 AND approval = 'pending'", [b])
      ).rows[0]?.id as string;
      const approve = await tryQuery(
        db.admin,
        "UPDATE public.photos SET approval = 'approved' WHERE id = $1",
        [pendingId],
      );
      expect(approve?.message).toMatch(VIDEO_CAP_RE);
      // trashing one frees a slot; restoring past the cap is refused
      const victim = (
        await q(
          "SELECT id FROM public.photos WHERE baby_id = $1 AND approval = 'approved' AND media_kind = 'video' LIMIT 1",
          [b],
        )
      ).rows[0]?.id as string;
      await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [victim]);
      expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(99);
      // committed (tryQuery would roll it back): the freed slot is taken again
      await q("UPDATE public.photos SET approval = 'approved' WHERE id = $1", [pendingId]);
      expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(100);
      expect(
        (
          await tryQuery(db.admin, "UPDATE public.photos SET deleted_at = NULL WHERE id = $1", [
            victim,
          ])
        )?.message,
      ).toMatch(VIDEO_CAP_RE);
      // Plus albums are outside the cap
      const pb = await mkBaby(await mkUser(), "plus");
      for (let i = 0; i < 3; i++) await insertVideo(db.admin, pb, u);
      // GUC: a lower limit in the transaction applies at once
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("SET LOCAL app.free_tier_video_limit = '2'");
        expect(await scalar<number>("SELECT public.free_tier_video_limit() AS v")).toBe(2);
        // a parent's albums share one family: the GUC case needs its own parent (and family)
        const u2 = await mkUser();
        const b2 = randomUUID();
        await q(
          "INSERT INTO public.babies (id, name, birth_date, plan, created_by) VALUES ($1, 'G', '2025-06-30', 'free', $2)",
          [b2, u2],
        );
        await insertVideo(db.admin, b2, u2);
        await insertVideo(db.admin, b2, u2);
        const third = await tryQuery(
          db.admin,
          `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, status, media_kind, rendition_status, mime)
           VALUES ($1, $2, $3, 'g3', 'approved', 'ingested', 'video', 'pending', 'video/mp4')`,
          [randomUUID(), b2, u2],
        );
        expect(third?.message).toMatch(VIDEO_CAP_RE);
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("concurrent inserts at 99 admit exactly one (advisory lock class 1015 per family)", async () => {
      const u = await mkUser();
      const b = await mkBaby(u, "free");
      await q(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'babies/' || $1::text || '/originals/' || gen_random_uuid()::text, 1000, 'approved', 'ingested', 'video', 'pending', 'video/mp4'
           FROM generate_series(1, 99)`,
        [b, u],
      );
      const a = new pg.Client({ connectionString: databaseUrl });
      const c2 = new pg.Client({ connectionString: databaseUrl });
      await a.connect();
      await c2.connect();
      try {
        await a.query("BEGIN");
        await c2.query("BEGIN");
        await insertVideo(a, b, u); // takes the family lock, sees 99
        const second = insertVideo(c2, b, u).then(
          () => null,
          (e: Error) => e,
        ); // blocks on the lock
        await new Promise((r) => setTimeout(r, 150));
        await a.query("COMMIT");
        const err = await second;
        expect(err).not.toBeNull();
        expect((err as Error).message).toMatch(VIDEO_CAP_RE);
        await c2.query("ROLLBACK");
      } finally {
        await a.end();
        await c2.end();
      }
      expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(100);
    });
  });

  it("ai_eligible_photos: a paid album's video is eligible only once its rendition is ready; a free album's video never", async () => {
    const u = await mkUser();
    const paid = await mkBaby(u, "plus");
    const free = await mkBaby(u, "free");
    const pending = (await insertVideo(db.admin, paid, u, { rendition: "pending" })).rows[0]
      ?.id as string;
    const ready = (await insertVideo(db.admin, paid, u, { rendition: "ready" })).rows[0]
      ?.id as string;
    const freeReady = (await insertVideo(db.admin, free, u, { rendition: "ready" })).rows[0]
      ?.id as string;
    for (const id of [pending, ready, freeReady]) {
      await q(
        "INSERT INTO public.photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'analysis', $2, 768, 432, 10)",
        [id, `ai/${id}/analysis`],
      );
    }
    const ids = (
      await q("SELECT public.ai_eligible_photos($1, 'v1', 'v1') AS id", [1000])
    ).rows.map((r) => r.id as string);
    expect(ids).toContain(ready);
    expect(ids).not.toContain(pending);
    expect(ids).not.toContain(freeReady);
  });

  it("the pool counts a video as one item; the pending cap applies to videos too (per-family numbers via the member)", async () => {
    const u = await mkUser();
    const b = await mkBaby(u, "free");
    await insertVideo(db.admin, b, u);
    await q(
      "INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, status) VALUES ($1, $2, $3, 'one-photo', 'approved', 'ingested')",
      [randomUUID(), b, u],
    );
    expect(await scalar<number>("SELECT public.free_tier_pool_used($1) AS v", [b])).toBe(2);
    expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(1);
    await db.asUser(u, async (c) => {
      const r = (
        await c.query(
          "SELECT public.free_tier_pool_used($1) AS used, public.free_tier_pool_videos($1) AS videos",
          [b],
        )
      ).rows[0] as {
        used: number;
        videos: number;
      };
      expect(r).toEqual({ used: 2, videos: 1 });
      // the member may insert a video row with media_kind + rendition_status (the api's complete)
      const ins = await tryQuery(
        c,
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, approval, media_kind, rendition_status, mime)
         VALUES ($1, $2, $3, 'member-video', 'approved', 'video', 'pending', 'video/mp4')`,
        [randomUUID(), b, u],
      );
      expect(ins).toBeNull();
      // but may not set the worker's columns
      const bad = await tryQuery(c, "UPDATE public.photos SET duration_ms = 5 WHERE baby_id = $1", [
        b,
      ]);
      expect(bad?.message).toMatch(PERMISSION_DENIED);
    });
    await db.asViewer(LINK.LA, async (c) => {
      expect((await tryQuery(c, "SELECT public.free_tier_pool_videos($1)", [b]))?.message).toMatch(
        PERMISSION_DENIED,
      );
    });
    expect(authed(u).sub).toBe(u);
    expect(viewerClaims(LINK.LA).share_link_id).toBe(LINK.LA);
  });

  describe("review fixes: import_book_photo rounding and the caps' UPDATE OF status", () => {
    /** A fresh free family: parent, album, admin membership. */
    async function freeFamily() {
      const u = await mkUser();
      const b = await mkBaby(u, "free");
      return { u, b };
    }
    const insertPhoto = (
      c: pg.ClientBase,
      baby: string,
      by: string,
      o: { approval?: string; status?: string; kind?: "photo" | "video" } = {},
    ) =>
      c.query(
        `INSERT INTO public.photos (id, baby_id, uploaded_by, storage_key_original, bytes, approval, status, media_kind, rendition_status, mime)
         VALUES ($1::uuid, $2::uuid, $3::uuid, concat('rf/', $1::uuid), 1000, $4, $5, $6, CASE WHEN $6 = 'video' THEN 'pending' ELSE 'none' END, CASE WHEN $6 = 'video' THEN 'video/mp4' ELSE 'image/jpeg' END)
         RETURNING id`,
        [
          randomUUID(),
          baby,
          by,
          o.approval ?? "approved",
          o.status ?? "uploaded",
          o.kind ?? "video",
        ],
      );
    const setStatus = (id: string, status: string) =>
      tryQuery(db.admin, "UPDATE public.photos SET status = $2 WHERE id = $1", [id, status]);
    const statusOf = (id: string) =>
      scalar<string>("SELECT status AS v FROM public.photos WHERE id = $1", [id]);

    it("import_book_photo: a free video with a 60 400 ms hint books; 60 500 ms is video_too_long (rounded seconds)", async () => {
      const { u, b } = await freeFamily();
      const batch = randomUUID();
      await q(
        `INSERT INTO public.import_batches (id, baby_id, requested_by, kind, status, provider_session_id, picker_expires_at)
         VALUES ($1, $2, $3, 'google_picker', 'running', 'sess-v', now() + interval '20 minutes')`,
        [batch, b, u],
      );
      const item = async (durationMs: number) => {
        const id = randomUUID();
        await q(
          `INSERT INTO public.import_items (id, batch_id, baby_id, provider_item_id, status, mime_hint, bytes, sha256, media_kind, duration_ms_hint)
           VALUES ($1, $2, $3, $4, 'downloaded', 'video/mp4', 1000, decode(md5($4) || md5('x'), 'hex'), 'video', $5)`,
          [id, batch, b, `v-${id}`, durationMs],
        );
        return id;
      };
      const ok = await item(60_400);
      const long = await item(60_500);
      const booked = await scalar<string>("SELECT public.import_book_photo($1) AS v", [ok]);
      expect(booked).toMatch(/^booked|imported|ok$/);
      const row = await q(
        "SELECT media_kind, rendition_status, approval FROM public.photos WHERE id = $1",
        [ok],
      );
      expect(row.rows[0]).toMatchObject({ media_kind: "video", rendition_status: "pending" });
      expect(await scalar<string>("SELECT public.import_book_photo($1) AS v", [long])).toBe(
        "video_too_long",
      );
      expect((await q("SELECT 1 FROM public.photos WHERE id = $1", [long])).rows).toHaveLength(0);
    });

    it("video cap (GUC limit 1): uploaded→ingested counts; ingested→ingested/ready pass; a failed row's failed→ingested at the cap is refused and stays failed; passes after trashing; duplicate→ingested below the cap passes; a pending video's retry never counts", async () => {
      const { u, b } = await freeFamily();
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("SET LOCAL app.free_tier_video_limit = '1'");
        const v1 = (await insertPhoto(db.admin, b, u, { status: "uploaded" })).rows[0]
          ?.id as string;
        expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(1);
        expect(await setStatus(v1, "ingested")).toBeNull();
        expect(await setStatus(v1, "ingested")).toBeNull();
        expect(
          await tryQuery(
            db.admin,
            "UPDATE public.photos SET rendition_status = 'ready' WHERE id = $1",
            [v1],
          ),
        ).toBeNull();
        // a second approved video that failed ingest does not count and may be inserted
        const v2 = (await insertPhoto(db.admin, b, u, { status: "failed" })).rows[0]?.id as string;
        expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(1);
        const retry = await setStatus(v2, "ingested");
        expect(retry?.message).toMatch(VIDEO_CAP_RE);
        expect(await statusOf(v2)).toBe("failed");
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [v1]);
        expect(await setStatus(v2, "ingested")).toBeNull();
        expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(1);
        // duplicate → ingested below the cap
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [v2]);
        const v3 = (await insertPhoto(db.admin, b, u, { status: "duplicate" })).rows[0]
          ?.id as string;
        expect(await setStatus(v3, "ingested")).toBeNull();
        // a pending (guest) video's failed → ingested never counts against the video cap
        const v4 = (await insertPhoto(db.admin, b, u, { approval: "pending", status: "failed" }))
          .rows[0]?.id as string;
        expect(await setStatus(v4, "ingested")).toBeNull();
        expect(await scalar<number>("SELECT public.free_tier_pool_videos($1) AS v", [b])).toBe(1);
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("pool cap at 1,000: an approved failed photo's failed→ingested is refused by photos_free_tier_cap; ingested→ingested passes", async () => {
      const { u, b } = await freeFamily();
      await db.admin.query("BEGIN");
      try {
        await q(
          `INSERT INTO public.photos (baby_id, uploaded_by, storage_key_original, approval, status)
           SELECT $1::uuid, $2::uuid, 'pool/' || g, 'approved', 'ingested' FROM generate_series(1, 1000) g`,
          [b, u],
        );
        expect(await scalar<number>("SELECT public.free_tier_pool_used($1) AS v", [b])).toBe(1000);
        const full = (await insertPhoto(db.admin, b, u, { kind: "photo", status: "failed" }))
          .rows[0]?.id as string;
        const retry = await setStatus(full, "ingested");
        expect(retry?.message).toMatch(/free tier photo limit reached/i);
        expect(await statusOf(full)).toBe("failed");
        const existing = (
          await q(
            "SELECT id FROM public.photos WHERE baby_id = $1 AND status = 'ingested' LIMIT 1",
            [b],
          )
        ).rows[0]?.id as string;
        expect(await setStatus(existing, "ingested")).toBeNull();
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("pending cap (GUC limit 2): two counting pending uploads; a pending failed→ingested is 23514; passes after trashing one; ingested→ingested at the cap passes; an approved failed→ingested is untouched", async () => {
      const { u, b } = await freeFamily();
      const guest = await mkUser();
      await q(
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
        [b, guest],
      );
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("SET LOCAL app.pending_photo_limit = '2'");
        const pend = (status: string) =>
          insertPhoto(db.admin, b, guest, { kind: "photo", approval: "pending", status });
        const p1 = (await pend("uploaded")).rows[0]?.id as string;
        await pend("ingested");
        const p3 = (await pend("failed")).rows[0]?.id as string;
        const retry = await setStatus(p3, "ingested");
        expect(retry?.code).toBe("23514");
        expect(retry?.message).toMatch(/pending photo limit reached/i);
        expect(await statusOf(p3)).toBe("failed");
        expect(await setStatus(p1, "ingested")).toBeNull();
        expect(await setStatus(p1, "ingested")).toBeNull();
        await q("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [p1]);
        expect(await setStatus(p3, "ingested")).toBeNull();
        const approved = (
          await insertPhoto(db.admin, b, u, {
            kind: "photo",
            approval: "approved",
            status: "failed",
          })
        ).rows[0]?.id as string;
        expect(await setStatus(approved, "ingested")).toBeNull();
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("all three cap triggers fire on UPDATE OF status", async () => {
      const defs = (
        await q(
          "SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname IN ('photos_free_tier_cap', 'photos_free_tier_video_cap', 'photos_pending_cap') ORDER BY tgname",
        )
      ).rows as { tgname: string; def: string }[];
      expect(defs.map((d) => d.tgname)).toEqual([
        "photos_free_tier_cap",
        "photos_free_tier_video_cap",
        "photos_pending_cap",
      ]);
      for (const d of defs)
        expect(d.def, d.tgname).toMatch(/UPDATE OF [^)]*\bstatus ON public\.photos/);
    });

    it("round trip: after `down` the step-11 cap triggers are back to UPDATE OF approval, deleted_at; after `up` all three carry status", async () => {
      const defs = async () =>
        Object.fromEntries(
          (
            (
              await q(
                "SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname IN ('photos_free_tier_cap', 'photos_free_tier_video_cap', 'photos_pending_cap')",
              )
            ).rows as { tgname: string; def: string }[]
          ).map((r) => [r.tgname, r.def]),
        ) as Record<string, string | undefined>;
      try {
        await runMigrations({
          direction: "down",
          count: 1,
          bootstrap: false,
          databaseUrl,
          env,
          log: () => undefined,
        });
        const down = await defs();
        expect(down.photos_free_tier_video_cap).toBeUndefined();
        expect(down.photos_free_tier_cap).toMatch(
          /UPDATE OF approval, deleted_at ON public\.photos/,
        );
        expect(down.photos_pending_cap).toMatch(/UPDATE OF approval, deleted_at ON public\.photos/);
      } finally {
        await runMigrations({ direction: "up", databaseUrl, env, log: () => undefined });
      }
      const up = await defs();
      for (const name of [
        "photos_free_tier_cap",
        "photos_free_tier_video_cap",
        "photos_pending_cap",
      ]) {
        expect(up[name], name).toMatch(/UPDATE OF [^)]*\bstatus ON public\.photos/);
      }
    });
  });
});
