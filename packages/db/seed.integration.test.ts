import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @littlelight/shared: relative import on purpose.
import { DEMO_IDS } from "../shared/src/constants";
import { DEMO, type SeedResult, seed, seedFromEnv } from "./src/index";
import { connect, DATA_KEY, type Db, databaseUrl, ensureMigrated, env } from "./test/harness";

// Demo-family seed (docs/plans/step-2.md 2.9): idempotent, dev-only, GoTrue-compatible rows,
// encrypted coordinates, and the seeded world behaves correctly under RLS.

describe.skipIf(!databaseUrl)("demo seed", () => {
  let db: Db;
  let first: SeedResult;
  let second: SeedResult;
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows[0] as T;
  const idSet = async (table: string, col = "id") =>
    (await db.admin.query(`SELECT ${col}::text AS k FROM ${table} ORDER BY 1`)).rows.map(
      (r) => r.k as string,
    );

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    first = await seed({ env, databaseUrl, log });
  });
  afterAll(async () => {
    await db?.close();
  });

  it("runs twice with identical counts and identical key sets", async () => {
    const before = {
      photos: await idSet("photos"),
      members: await idSet("baby_members", "user_id"),
      shared: await idSet("shared_photos", "photo_id"),
      users: await idSet("profiles", "user_id"),
      exif: await idSet("photo_exif", "photo_id"),
    };
    second = await seed({ env, databaseUrl, log });
    expect(second.counts).toEqual(first.counts);
    expect({
      photos: await idSet("photos"),
      members: await idSet("baby_members", "user_id"),
      shared: await idSet("shared_photos", "photo_id"),
      users: await idSet("profiles", "user_id"),
      exif: await idSet("photo_exif", "photo_id"),
    }).toEqual(before);
    // The counts reported are the real counts.
    for (const [table, n] of Object.entries(second.counts)) {
      const real = await one<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
      expect(real.n, table).toBeGreaterThanOrEqual(n);
    }
  });

  it("seeds the documented family: 12 photos, 3 members, 4 hand-shared photos", async () => {
    expect(first.counts).toMatchObject({
      photos: 12,
      baby_members: 3,
      shared_photos: 4,
      share_links: 1,
    });
    expect(
      (
        await one<{ n: number }>("SELECT count(*)::int n FROM baby_members WHERE baby_id = $1", [
          DEMO.baby,
        ])
      ).n,
    ).toBe(3);
    const roles = await db.admin.query(
      "SELECT user_id, role FROM baby_members WHERE baby_id = $1 ORDER BY user_id",
      [DEMO.baby],
    );
    expect(roles.rows).toEqual([
      { user_id: DEMO.users.mom, role: "admin" },
      { user_id: DEMO.users.dad, role: "admin" },
      { user_id: DEMO.users.nanny, role: "contributor" },
    ]);
    const baby = await one<{ name: string; plan: string; plan_owner_user_id: string }>(
      "SELECT name, plan, plan_owner_user_id FROM babies WHERE id = $1",
      [DEMO.baby],
    );
    expect(baby).toEqual({ name: "Maya", plan: "plus", plan_owner_user_id: DEMO.users.mom });
  });

  it("photo states: 2 pending (nanny), 1 trashed, 1 sensitive, at least 8 live approved", async () => {
    const r = await one<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE approval = 'pending')::int pending,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)::int trashed,
              count(*) FILTER (WHERE is_sensitive)::int sensitive,
              count(*) FILTER (WHERE approval = 'approved' AND deleted_at IS NULL)::int live_approved,
              count(*) FILTER (WHERE approval = 'pending' AND uploaded_by = $2)::int pending_by_nanny
         FROM photos WHERE baby_id = $1`,
      [DEMO.baby, DEMO.users.nanny],
    );
    expect(r).toMatchObject({ pending: 2, trashed: 1, sensitive: 1, pending_by_nanny: 2 });
    expect(r.live_approved).toBeGreaterThanOrEqual(8);
  });

  it("encrypted coordinates: ciphertext at rest, plaintext only with the key", async () => {
    const raw = await one<{ t: string; len: number }>(
      "SELECT home_lat_enc::text t, octet_length(home_lat_enc) len FROM babies WHERE id = $1",
      [DEMO.baby],
    );
    expect(raw.t).not.toContain("47.6062");
    expect(raw.len).toBeGreaterThan(16);
    await db.admin.query("BEGIN");
    try {
      await db.admin.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
      const r = await one<{ lat: number; lng: number }>(
        "SELECT decrypt_coord(home_lat_enc) lat, decrypt_coord(home_lng_enc) lng FROM babies WHERE id = $1",
        [DEMO.baby],
      );
      expect(r).toEqual({ lat: 47.6062, lng: -122.3321 });
    } finally {
      await db.admin.query("ROLLBACK");
    }
    const exif = await one<{ with_gps: number; total: number; bad_json: number }>(
      `SELECT count(*) FILTER (WHERE gps_lat_enc IS NOT NULL)::int with_gps, count(*)::int total,
              count(*) FILTER (WHERE jsonb_has_gps_keys(raw_json))::int bad_json
         FROM photo_exif WHERE photo_id = ANY($1::uuid[])`,
      [DEMO_IDS.photos],
    );
    expect(exif.with_gps).toBe(1);
    expect(exif.bad_json).toBe(0);
    expect(exif.total).toBeGreaterThanOrEqual(8);
  });

  it("sensitive demo photo carries a photo_ai row with the bath flag and is only hand-shared and hidden (never a rule row)", async () => {
    const r = await one<{ flags: string[] }>(
      "SELECT sensitive_flags flags FROM photo_ai pa JOIN photos p ON p.id = pa.photo_id WHERE p.is_sensitive AND p.baby_id = $1",
      [DEMO.baby],
    );
    expect(r.flags).toEqual(["bath"]);
    // Step 8: mom hand-picked it (a hidden tile for the viewer): a `user` row, never released, and
    // no `rule` row of a sensitive photo exists anywhere.
    const shared = await one<{ n: number; user_hidden: number }>(
      `SELECT count(*)::int n,
              count(*) FILTER (WHERE sp.added_by = 'user' AND sp.sensitive_released_at IS NULL)::int user_hidden
         FROM shared_photos sp JOIN photos p ON p.id = sp.photo_id
        WHERE p.is_sensitive AND sp.share_link_id = $1`,
      [DEMO.shareLink],
    );
    expect(shared).toEqual({ n: 1, user_hidden: 1 });
    const rule = await one<{ n: number }>(
      "SELECT count(*)::int n FROM shared_photos sp JOIN photos p ON p.id = sp.photo_id WHERE p.is_sensitive AND sp.added_by = 'rule'",
    );
    expect(rule.n).toBe(0);
  });

  it("share link: sha256 of the dev token is stored, never the token; expiry is refreshed each run", async () => {
    const r = await one<{ token_hash: Buffer; name: string }>(
      "SELECT token_hash, name FROM share_links WHERE id = $1",
      [DEMO.shareLink],
    );
    expect(r.name).toBe("Grandparents");
    expect(r.token_hash.toString("hex")).toBe(sha(DEMO.shareToken));
    const exp = await one<{ hrs: number }>(
      "SELECT extract(epoch FROM (expires_at - now())) / 3600 AS hrs FROM share_links WHERE id = $1",
      [DEMO.shareLink],
    );
    expect(Number(exp.hrs)).toBeGreaterThan(23);
    expect(Number(exp.hrs)).toBeLessThanOrEqual(24.01);
    // Let it go stale, as after a day of dev: the next start makes it fresh again.
    await db.admin.query(
      "UPDATE share_links SET expires_at = now() - interval '2 days', revoked_at = now() WHERE id = $1",
      [DEMO.shareLink],
    );
    await seed({ env, databaseUrl, log });
    const again = await one<{ hrs: number; revoked_at: Date | null }>(
      "SELECT extract(epoch FROM (expires_at - now())) / 3600 AS hrs, revoked_at FROM share_links WHERE id = $1",
      [DEMO.shareLink],
    );
    expect(Number(again.hrs)).toBeGreaterThan(23);
    expect(again.revoked_at).toBeNull();
  });

  it("GoTrue-compatible auth rows: confirmed, string tokens (never NULL), identities", async () => {
    const u = await db.admin.query(
      `SELECT email, aud, role, email_confirmed_at IS NOT NULL AS confirmed,
              confirmation_token, recovery_token, email_change, email_change_token_new
         FROM auth.users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [Object.values(DEMO_IDS.users)],
    );
    expect(u.rows.map((r) => r.email)).toEqual([
      "demo-mom@littlelight.local",
      "demo-dad@littlelight.local",
      "demo-nanny@littlelight.local",
    ]);
    for (const r of u.rows) {
      expect(r).toMatchObject({
        aud: "authenticated",
        role: "authenticated",
        confirmed: true,
      });
      // GoTrue scans these as strings, so NULL breaks sign-in. The seed inserts "" but GoTrue
      // itself fills recovery_token / confirmation_token on a real sign-in, so a dev DB that has
      // been used holds non-empty values: assert "not NULL", not "empty".
      for (const col of [
        "confirmation_token",
        "recovery_token",
        "email_change",
        "email_change_token_new",
      ]) {
        expect(typeof r[col], `${r.email} ${col}`).toBe("string");
      }
    }
    const ids = await db.admin.query(
      "SELECT provider, provider_id, user_id FROM auth.identities WHERE user_id = ANY($1::uuid[]) ORDER BY user_id",
      [Object.values(DEMO_IDS.users)],
    );
    expect(ids.rows).toHaveLength(3);
    for (const r of ids.rows) {
      expect(r.provider).toBe("email");
      expect(r.provider_id).toBe(r.user_id);
    }
  });

  it("every demo original is a JPEG at babies/<baby>/originals/<photo>.jpg (step 9: real illustrations)", async () => {
    const r = await db.admin.query(
      "SELECT id, mime, storage_key_original AS key FROM public.photos WHERE baby_id = $1 ORDER BY id",
      [DEMO.baby],
    );
    expect(r.rows).toHaveLength(12);
    for (const row of r.rows) {
      expect(row.mime, row.id).toBe("image/jpeg");
      expect(row.key, row.id).toBe(`babies/${DEMO.baby}/originals/${row.id}.jpg`);
    }
  });

  it("re-seeding keeps the real photo and derivative sizes the worker wrote (and restores a changed key)", async () => {
    const photo = DEMO.photo(2);
    await db.admin.query(
      "UPDATE public.photos SET width = 1234, height = 987, bytes = 55555 WHERE id = $1",
      [photo],
    );
    await db.admin.query(
      "UPDATE public.photo_derivatives SET width = 321, height = 123, bytes = 4242 WHERE photo_id = $1 AND kind = 'thumb'",
      [photo],
    );
    await seed({ env, databaseUrl, log });
    const p = await one<{ width: number; height: number; bytes: number }>(
      "SELECT width, height, bytes::int FROM public.photos WHERE id = $1",
      [photo],
    );
    expect(p).toEqual({ width: 1234, height: 987, bytes: 55555 });
    const d = await one<{ width: number; height: number; bytes: number }>(
      "SELECT width, height, bytes::int FROM public.photo_derivatives WHERE photo_id = $1 AND kind = 'thumb'",
      [photo],
    );
    expect(d).toEqual({ width: 321, height: 123, bytes: 4242 });

    // A derivative whose key was changed is restored whole (its sizes described another object).
    await db.admin.query(
      "UPDATE public.photo_derivatives SET storage_key = 'elsewhere/thumb.jpg', width = 5 WHERE photo_id = $1 AND kind = 'thumb'",
      [photo],
    );
    await seed({ env, databaseUrl, log });
    const restored = await one<{ storage_key: string; width: number }>(
      "SELECT storage_key, width FROM public.photo_derivatives WHERE photo_id = $1 AND kind = 'thumb'",
      [photo],
    );
    expect(restored.storage_key).toBe(`babies/${DEMO.baby}/derivatives/${photo}/thumb.jpg`);
    expect(restored.width).toBe(300);
  });

  it("logs counts and the dev share token only: no coordinates, keys or notes", () => {
    const text = lines.join("\n");
    expect(text).toContain("seed:");
    for (const forbidden of ["47.6062", "-122.3321", DATA_KEY]) {
      expect(text).not.toContain(forbidden);
    }
  });

  // --- the seeded world under RLS (the manual spot checks of plan section 4) ---------------------
  describe("seeded family under RLS", () => {
    it("mom and dad (admins) see all 12 photos; the nanny sees live approved + her own pending", async () => {
      await db.asUser(DEMO.users.mom, async (c) => {
        expect((await c.query("SELECT count(*)::int n FROM photos")).rows[0].n).toBe(12);
        expect(
          (await c.query("SELECT count(*)::int n FROM photo_search")).rows[0].n,
        ).toBeGreaterThanOrEqual(8);
      });
      await db.asUser(DEMO.users.dad, async (c) => {
        expect((await c.query("SELECT count(*)::int n FROM photos")).rows[0].n).toBe(12);
      });
      await db.asUser(DEMO.users.nanny, async (c) => {
        const r = await c.query(
          "SELECT count(*) FILTER (WHERE approval = 'pending')::int pending, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int trashed, count(*)::int total FROM photos",
        );
        expect(r.rows[0].pending).toBe(2);
        expect(r.rows[0].trashed).toBe(0);
        expect(r.rows[0].total).toBe(11);
        await expect(c.query("DELETE FROM photos")).rejects.toThrow(/permission denied/);
      });
    });

    it("a stranger sees none of the demo family", async () => {
      await db.asUser("00000000-0000-4000-8000-0000000000ff", async (c) => {
        expect((await c.query("SELECT count(*)::int n FROM photos")).rows[0].n).toBe(0);
        expect((await c.query("SELECT count(*)::int n FROM babies")).rows[0].n).toBe(0);
      });
    });

    it("the Grandparents viewer sees 4 album rows (3 visible photos + 1 hidden tile) and nothing else", async () => {
      await db.asViewer(DEMO.shareLink, async (c) => {
        expect((await c.query("SELECT count(*)::int n FROM shared_photos")).rows[0].n).toBe(4);
        expect((await c.query("SELECT count(*)::int n FROM photos")).rows[0].n).toBe(4);
        // The hidden (sensitive, unreleased) one has no readable derivative.
        expect(
          (await c.query("SELECT count(*)::int n FROM photo_derivatives")).rows[0].n,
        ).toBeLessThanOrEqual(8);
        await expect(c.query("SELECT count(*) FROM photo_exif")).rejects.toThrow(
          /permission denied for table photo_exif/,
        );
      });
    });
  });

  // --- gating ------------------------------------------------------------------------------------
  describe("gating", () => {
    const bogusDb = "postgres://nobody:nope@127.0.0.1:1/none"; // would fail loudly if touched

    it("SEED_DEMO_FAMILY unset: exits 0 'skipped' without touching the database", async () => {
      const out: string[] = [];
      const code = await seedFromEnv(
        { DATABASE_URL: bogusDb, DATA_ENCRYPTION_KEY: DATA_KEY },
        (l) => out.push(l),
      );
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(/skipped/);
    });

    it("SEED_DEMO_FAMILY=false or anything but 'true' also skips", async () => {
      for (const v of ["false", "1", "TRUE", ""]) {
        expect(
          await seedFromEnv({ DATABASE_URL: bogusDb, SEED_DEMO_FAMILY: v }, () => undefined),
          v,
        ).toBe(0);
      }
    });

    it("NODE_ENV=production refuses with exit 1 and never connects", async () => {
      const out: string[] = [];
      const code = await seedFromEnv(
        {
          DATABASE_URL: bogusDb,
          SEED_DEMO_FAMILY: "true",
          NODE_ENV: "production",
          DATA_ENCRYPTION_KEY: DATA_KEY,
        },
        (l) => out.push(l),
      );
      expect(code).toBe(1);
      expect(out.join("\n")).toMatch(/refus/);
    });

    it("production + flag leaves the data untouched", async () => {
      const before = await one<{ n: number }>(
        "SELECT count(*)::int n FROM audit_log WHERE event = 'seed.demo_family'",
      );
      await db.admin.query("UPDATE share_links SET name = 'marker' WHERE id = $1", [
        DEMO.shareLink,
      ]);
      await seedFromEnv(
        {
          DATABASE_URL: databaseUrl,
          SEED_DEMO_FAMILY: "true",
          NODE_ENV: "production",
          DATA_ENCRYPTION_KEY: DATA_KEY,
        },
        () => undefined,
      );
      expect(
        (
          await one<{ name: string }>("SELECT name FROM share_links WHERE id = $1", [
            DEMO.shareLink,
          ])
        ).name,
      ).toBe("marker");
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM audit_log WHERE event = 'seed.demo_family'",
          )
        ).n,
      ).toBe(before.n);
      await seed({ env, databaseUrl, log }); // restore
    });

    it("requires DATA_ENCRYPTION_KEY (>= 32 chars) and never echoes it", async () => {
      const missing = seed({ env: { DATABASE_URL: databaseUrl }, databaseUrl, log });
      await expect(missing).rejects.toThrow(/DATA_ENCRYPTION_KEY/);
      const short = `s3cret${"X".repeat(10)}`;
      const err = await seed({
        env: { DATABASE_URL: databaseUrl, DATA_ENCRYPTION_KEY: short },
        databaseUrl,
        log,
      }).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("DATA_ENCRYPTION_KEY");
      expect((err as Error).message).not.toContain(short);
    });

    it("fails cleanly (rolled back) when the schema is missing", async () => {
      // A database with no app schema: use a throwaway one.
      const name = `ll_seed_empty_${process.pid}`;
      await db.admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await db.admin.query(`CREATE DATABASE ${name}`);
      try {
        const url = new URL(databaseUrl as string);
        url.pathname = `/${name}`;
        const pg = (await import("pg")).default;
        const c = new pg.Client({ connectionString: url.toString() });
        await c.connect();
        await c.query("CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid primary key)");
        await c.end();
        await expect(seed({ env, databaseUrl: url.toString(), log })).rejects.toThrow(
          /run pnpm db:migrate/,
        );
      } finally {
        await db.admin.query(`DROP DATABASE IF EXISTS ${name}`);
      }
    });
  });
});
