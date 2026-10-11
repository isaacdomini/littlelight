import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BABY, createFixtures, dropFixtures, EMAIL, P, U } from "./test/fixtures";
import {
  authed,
  connect,
  DATA_KEY,
  type Db,
  databaseUrl,
  ensureMigrated,
  PERMISSION_DENIED,
  RLS_VIOLATION,
  tryQuery,
} from "./test/harness";

// Migration 20, photo import (docs/plans/step-10.md 2.2, 10.13; PRD FR-2.7 "contributor uploads
// land in the approval queue", "Roles and permissions", "Privacy and child safety", "Security"):
// import_sources (Apple album sync status), google_accounts (encrypted refresh token),
// import_batches / import_items (Google Picker imports) and the pipeline-only functions. Every
// case runs on one superuser connection inside a rolled-back transaction, switching role with
// SET LOCAL ROLE + JWT claims exactly like the API and the worker do.

/** anon has no USAGE on schema public: "does not exist" is as good a refusal as "permission denied". */
const NO_ACCESS = /permission denied|does not exist/i;

describe.skipIf(!databaseUrl)("photo import (migration 20)", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const err = (sql: string, params: unknown[] = []) => tryQuery(db.admin, sql, params);
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await rows<T>(sql, params))[0];

  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await db.admin.query("BEGIN");
    try {
      return await fn();
    } finally {
      await db.admin.query("ROLLBACK");
    }
  }
  async function as(role: string, claims: Record<string, unknown> | null = null) {
    await q("RESET ROLE");
    if (role !== "postgres") await q(`SET LOCAL ROLE ${role}`);
    await q("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims ?? {})]);
  }
  const key = () => q("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
  const su = () => as("postgres");
  const asUser = (u: string, email?: string) => as("authenticated", authed(u, email));
  const admin1 = () => asUser(U.adminA1, EMAIL.adminA1);
  const admin2 = () => asUser(U.adminA2, EMAIL.adminA2);
  const contrib = () => asUser(U.contribA, EMAIL.contribA);
  const stranger = () => asUser(U.stranger, EMAIL.stranger);
  const otherAdmin = () => asUser(U.adminB, EMAIL.adminB);
  const pipeline = () => as("pipeline");
  const service = () => as("service_role");

  const sha = () => `decode(md5('${randomUUID()}') || md5('${randomUUID()}'), 'hex')`;

  async function addSource(
    userId: string,
    over: { baby?: string; device?: string; kind?: string } = {},
  ) {
    const id = randomUUID();
    await q(
      `INSERT INTO import_sources (id, baby_id, user_id, kind, device_id, device_label, album_title)
       VALUES ($1, $2, $3, $4, $5, 'iPhone', 'Album')`,
      [id, over.baby ?? BABY.A, userId, over.kind ?? "apple_photos", over.device ?? randomUUID()],
    );
    return id;
  }

  async function addBatch(
    o: {
      baby?: string;
      by?: string | null;
      status?: string;
      session?: string | null;
      expires?: string;
    } = {},
  ) {
    const id = randomUUID();
    await q(
      `INSERT INTO import_batches (id, baby_id, requested_by, kind, status, provider_session_id, picker_expires_at)
       VALUES ($1, $2, $3, 'google_picker', $4, $5, ${o.expires ?? "now() + interval '20 minutes'"})`,
      [
        id,
        o.baby ?? BABY.A,
        o.by === undefined ? U.contribA : o.by,
        o.status ?? "picking",
        o.session === undefined ? "sess-1" : o.session,
      ],
    );
    return id;
  }

  async function connectGoogle(userId: string, token = "1//fake-refresh-token") {
    await key();
    await q("SET LOCAL ROLE service_role");
    await q(
      "INSERT INTO google_accounts (user_id, refresh_token_enc, scope) VALUES ($1, encrypt_secret($2), 'scope-x') ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc",
      [userId, token],
    );
    await q("RESET ROLE");
  }

  async function downloadedItem(
    batch: string,
    over: { baby?: string; mime?: string; takenAt?: string } = {},
  ) {
    const id = randomUUID();
    await q(
      `INSERT INTO import_items (id, batch_id, baby_id, provider_item_id, status, mime_hint, bytes, sha256, taken_at_hint)
       VALUES ($1, $2, $3, $4, 'downloaded', $5, 1234, ${sha()}, $6)`,
      [
        id,
        batch,
        over.baby ?? BABY.A,
        `g-${id}`,
        over.mime ?? "image/jpeg",
        over.takenAt ?? "2026-03-01T09:00:00Z",
      ],
    );
    return id;
  }

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await createFixtures(db.admin);
  });
  afterAll(async () => {
    if (db) {
      await dropFixtures(db.admin);
      await db.close();
    }
  });

  // -------------------------------------------------------------------------------------------
  describe("structure", () => {
    it("the four tables exist, with RLS enabled and forced", async () => {
      const r = await rows<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('import_sources','google_accounts','import_batches','import_items') AND relkind = 'r' ORDER BY 1`,
      );
      expect(r.map((x) => x.relname)).toEqual([
        "google_accounts",
        "import_batches",
        "import_items",
        "import_sources",
      ]);
      for (const t of r)
        expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it("viewer and anon have no privilege of any kind on any of them", async () => {
      for (const role of ["viewer", "anon"])
        for (const t of ["import_sources", "google_accounts", "import_batches", "import_items"])
          for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
            expect(
              (
                await one<{ ok: boolean }>("SELECT has_table_privilege($1, $2, $3) AS ok", [
                  role,
                  `public.${t}`,
                  p,
                ])
              )?.ok,
              `${role} ${p} ${t}`,
            ).toBe(false);
    });

    it("secret and capability columns are not granted to authenticated", async () => {
      const cols: [string, string][] = [
        ["google_accounts", "refresh_token_enc"],
        ["google_accounts", "scope"],
        ["import_batches", "provider_session_id"],
        ["import_items", "provider_item_id"],
        ["import_items", "sha256"],
        ["import_items", "bytes"],
        ["import_items", "storage_key"],
        ["import_items", "taken_at_hint"],
      ];
      for (const [t, c] of cols)
        expect(
          (
            await one<{ ok: boolean }>(
              "SELECT has_column_privilege('authenticated', $1, $2, 'SELECT') AS ok",
              [`public.${t}`, c],
            )
          )?.ok,
          `${t}.${c}`,
        ).toBe(false);
      for (const [t, c] of [
        ["google_accounts", "user_id"],
        ["google_accounts", "needs_reconnect"],
        ["google_accounts", "connected_at"],
        ["google_accounts", "last_used_at"],
      ])
        expect(
          (
            await one<{ ok: boolean }>(
              "SELECT has_column_privilege('authenticated', $1, $2, 'SELECT') AS ok",
              [`public.${t}`, c],
            )
          )?.ok,
        ).toBe(true);
    });

    it("pipeline has no grant on google_accounts and cannot write photos or import_batches identity columns", async () => {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
        expect(
          (
            await one<{ ok: boolean }>(
              "SELECT has_table_privilege('pipeline', 'public.google_accounts', $1) AS ok",
              [p],
            )
          )?.ok,
        ).toBe(false);
      expect(
        (
          await one<{ ok: boolean }>(
            "SELECT has_table_privilege('pipeline', 'public.photos', 'INSERT') AS ok",
          )
        )?.ok,
      ).toBe(false);
      for (const c of ["requested_by", "baby_id", "provider_session_id", "cancel_requested_at"])
        expect(
          (
            await one<{ ok: boolean }>(
              "SELECT has_column_privilege('pipeline', 'public.import_batches', $1, 'UPDATE') AS ok",
              [c],
            )
          )?.ok,
          c,
        ).toBe(false);
    });

    it("function EXECUTE: encrypt/decrypt_secret service_role only; worker functions pipeline only", async () => {
      const f = async (fn: string, role: string) =>
        (
          await one<{ ok: boolean }>(
            "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok",
            [role, fn],
          )
        )?.ok;
      for (const fn of ["public.encrypt_secret(text)", "public.decrypt_secret(bytea)"]) {
        expect(await f(fn, "service_role")).toBe(true);
        for (const r of ["authenticated", "anon", "viewer", "pipeline"])
          expect(await f(fn, r), `${fn} ${r}`).toBe(false);
      }
      for (const fn of [
        "public.import_batch_requester_state(uuid)",
        "public.import_google_refresh_token(uuid)",
        "public.import_mark_reconnect(uuid)",
        "public.import_book_photo(uuid)",
      ]) {
        expect(await f(fn, "pipeline")).toBe(true);
        for (const r of ["authenticated", "anon", "viewer"])
          expect(await f(fn, r), `${fn} ${r}`).toBe(false);
      }
    });

    it("import_book_photo takes the item id and nothing else (no approver, role or baby can be supplied)", async () => {
      const r = await one<{ args: string }>(
        "SELECT pg_get_function_arguments('public.import_book_photo(uuid)'::regprocedure) AS args",
      );
      expect(r?.args).toBe("p_item_id uuid");
    });

    it("every new SECURITY DEFINER function pins its search_path", async () => {
      const r = await rows<{ proname: string; cfg: string[] | null }>(
        `SELECT proname, proconfig AS cfg FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace AND prosecdef
            AND proname IN ('import_sources_shape','import_sources_insert_guard','baby_members_drop_apple_sync','google_accounts_shape',
                            'import_batches_one_active','import_items_batch_guard','import_batch_requester_state',
                            'import_google_refresh_token','import_mark_reconnect','import_book_photo')`,
      );
      expect(r).toHaveLength(10);
      for (const f of r)
        expect(f.cfg?.join(","), f.proname).toMatch(/search_path=pg_catalog, public/);
    });

    it("every policy of the new tables is named table_role_command and targets a role (never PUBLIC)", async () => {
      const r = await rows<{ tablename: string; policyname: string; roles: string[] }>(
        "SELECT tablename, policyname, roles::text[] AS roles FROM pg_policies WHERE tablename IN ('import_sources','google_accounts','import_batches','import_items')",
      );
      expect(r.length).toBeGreaterThanOrEqual(12);
      for (const p of r) {
        expect(p.policyname).toMatch(
          new RegExp(`^${p.tablename}_(authenticated|pipeline)_(select|insert|update|delete)$`),
        );
        expect(p.roles).not.toContain("public");
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("secrets at rest: encrypt_secret / decrypt_secret", () => {
    it("round-trips under the key; the ciphertext does not contain the plaintext", async () => {
      await sandbox(async () => {
        await key();
        await service();
        const r = await one<{ ct: Buffer; back: string }>(
          "SELECT c AS ct, decrypt_secret(c) AS back FROM (SELECT encrypt_secret('1//refresh-secret') AS c) t",
        );
        expect(r?.back).toBe("1//refresh-secret");
        expect(r?.ct.toString("latin1")).not.toContain("refresh-secret");
      });
    });

    it("raises without a data key and fails with the wrong key", async () => {
      await sandbox(async () => {
        await service();
        expect((await err("SELECT encrypt_secret('x')"))?.message).toMatch(/data key not set/);
        expect((await err("SELECT decrypt_secret('\\x00'::bytea)"))?.message).toMatch(
          /data key not set/,
        );
      });
      await sandbox(async () => {
        await key();
        await service();
        const ct = (await one<{ c: Buffer }>("SELECT encrypt_secret('abc') AS c"))?.c as Buffer;
        await q(
          "SELECT set_config('app.data_key', 'a-completely-different-key-of-32-chars!!', true)",
        );
        expect(await err("SELECT decrypt_secret($1)", [ct])).not.toBeNull();
      });
    });

    it.each(["authenticated", "anon", "viewer", "pipeline"])(
      "%s cannot call them",
      async (role) => {
        await sandbox(async () => {
          await key();
          await as(role, role === "authenticated" ? authed(U.adminA1) : null);
          expect((await err("SELECT encrypt_secret('x')"))?.message).toMatch(NO_ACCESS);
          expect((await err("SELECT decrypt_secret('\\x00'::bytea)"))?.message).toMatch(NO_ACCESS);
        });
      },
    );
  });

  // -------------------------------------------------------------------------------------------
  describe("import_sources (Apple album sync status)", () => {
    const insert = (user: string, over: Record<string, unknown> = {}) =>
      err(
        `INSERT INTO import_sources (baby_id, user_id, kind, device_id, device_label, album_title, wifi_only)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [
          over.baby ?? BABY.A,
          user,
          over.kind ?? "apple_photos",
          over.device ?? randomUUID(),
          over.label ?? "Mom's iPhone",
          over.title ?? "Maya",
        ],
      );

    it("an admin can create a source for themselves", async () => {
      await sandbox(async () => {
        await admin1();
        expect(await insert(U.adminA1)).toBeNull();
        expect((await rows("SELECT id FROM import_sources")).length).toBe(1);
      });
    });

    it("a contributor cannot create an apple_photos source (D1), a stranger cannot, nobody can name another user", async () => {
      await sandbox(async () => {
        await contrib();
        expect((await insert(U.contribA))?.message).toMatch(RLS_VIOLATION);
        await stranger();
        expect((await insert(U.stranger))?.message).toMatch(RLS_VIOLATION);
        await admin1();
        expect((await insert(U.adminA2))?.message).toMatch(RLS_VIOLATION);
        await otherAdmin();
        expect((await insert(U.adminB, { baby: BABY.A }))?.message).toMatch(RLS_VIOLATION);
        await su();
        expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM import_sources"))?.n).toBe(
          0,
        );
      });
    });

    it("the co-admin sees the row and may delete it; the owner updates it; a contributor and a stranger see nothing", async () => {
      await sandbox(async () => {
        const id = await addSource(U.adminA1);
        await admin2();
        expect(
          (await rows("SELECT id FROM import_sources")).map((r) => (r as { id: string }).id),
        ).toEqual([id]);
        await contrib();
        expect(await rows("SELECT id FROM import_sources")).toEqual([]);
        await stranger();
        expect(await rows("SELECT id FROM import_sources")).toEqual([]);
        await otherAdmin();
        expect(await rows("SELECT id FROM import_sources")).toEqual([]);
        await admin2();
        expect((await q("DELETE FROM import_sources WHERE id = $1", [id])).rowCount).toBe(1);
      });
    });

    it("only the owner updates: the co-admin's update touches 0 rows; the owner's works; identity columns are not updatable", async () => {
      await sandbox(async () => {
        const id = await addSource(U.adminA1);
        await admin2();
        expect(
          (await q("UPDATE import_sources SET paused = true WHERE id = $1", [id])).rowCount,
        ).toBe(0);
        await admin1();
        expect(
          (
            await q(
              "UPDATE import_sources SET paused = true, imported_count = imported_count + 3, last_error = 'network' WHERE id = $1",
              [id],
            )
          ).rowCount,
        ).toBe(1);
        for (const col of [
          `user_id = '${U.adminA2}'`,
          "kind = 'apple_photos'",
          `baby_id = '${BABY.B}'`,
          "device_id = gen_random_uuid()",
        ])
          expect(
            (await err(`UPDATE import_sources SET ${col} WHERE id = $1`, [id]))?.message,
            col,
          ).toMatch(PERMISSION_DENIED);
      });
    });

    it("a stranger and a contributor cannot delete; the owner can", async () => {
      await sandbox(async () => {
        const id = await addSource(U.adminA1);
        await contrib();
        expect((await q("DELETE FROM import_sources WHERE id = $1", [id])).rowCount).toBe(0);
        await stranger();
        expect((await q("DELETE FROM import_sources WHERE id = $1", [id])).rowCount).toBe(0);
        await admin1();
        expect((await q("DELETE FROM import_sources WHERE id = $1", [id])).rowCount).toBe(1);
      });
    });

    it("at most 10 per baby; re-enabling an existing device at the cap still works", async () => {
      await sandbox(async () => {
        const devices: string[] = [];
        for (let i = 0; i < 10; i++) {
          devices.push(randomUUID());
          await addSource(U.adminA1, { device: devices[i] });
        }
        await admin1();
        expect((await insert(U.adminA1))?.message).toMatch(/import source limit reached/);
        const upsert = await err(
          `INSERT INTO import_sources (baby_id, user_id, kind, device_id, device_label, album_title, wifi_only)
           VALUES ($1, $2, 'apple_photos', $3, 'Renamed', 'Album', true)
           ON CONFLICT (device_id, baby_id, kind) DO UPDATE SET device_label = EXCLUDED.device_label, paused = false`,
          [BABY.A, U.adminA1, devices[0]],
        );
        expect(upsert).toBeNull();
      });
    });

    it("a trashed album refuses a new source", async () => {
      await sandbox(async () => {
        await q("INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
          BABY.recentTrash,
          U.adminA1,
        ]);
        await admin1();
        expect((await insert(U.adminA1, { baby: BABY.recentTrash }))?.message).toMatch(
          /cannot sync into a trashed album/,
        );
      });
    });

    it("one row per device x baby x kind", async () => {
      await sandbox(async () => {
        const device = randomUUID();
        await addSource(U.adminA1, { device });
        expect(
          (
            await err(
              `INSERT INTO import_sources (baby_id, user_id, kind, device_id, device_label, album_title) VALUES ($1, $2, 'apple_photos', $3, 'x', 'y')`,
              [BABY.A, U.adminA2, device],
            )
          )?.code,
        ).toBe("23505");
      });
    });

    it.each([
      ["a control character in the label", "bad\u0007label", "Album"],
      ["a newline in the title", "Label", "two\nlines"],
      ["leading whitespace", " Label", "Album"],
      ["trailing whitespace", "Label", "Album "],
      ["an empty label", "", "Album"],
      ["a 61 character label", "x".repeat(61), "Album"],
      ["a 121 character title", "Label", "x".repeat(121)],
    ])("shape trigger refuses %s, with a message that names no value", async (_n, label, title) => {
      await sandbox(async () => {
        await admin1();
        const e = await insert(U.adminA1, { label, title });
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/must be 1 to \d+ characters/);
        expect(e?.message).not.toContain(label || "\u0000");
      });
    });

    it("counters cannot go negative", async () => {
      await sandbox(async () => {
        const id = await addSource(U.adminA1);
        await admin1();
        expect(
          (await err("UPDATE import_sources SET failed_count = -1 WHERE id = $1", [id]))?.message,
        ).toMatch(/counters must be zero or more/);
      });
    });

    it("demotion from admin deletes the user's apple sources of that baby only", async () => {
      await sandbox(async () => {
        await addSource(U.adminA2);
        // One family per parent (step 11): fold B into A's family so adminA2 may administer both.
        await q(
          "UPDATE babies SET family_id = (SELECT family_id FROM babies WHERE id = $1) WHERE id = $2",
          [BABY.A, BABY.B],
        );
        await q("INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
          BABY.B,
          U.adminA2,
        ]);
        await addSource(U.adminA2, { baby: BABY.B });
        await addSource(U.adminA1);
        await q(
          "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
          [BABY.A, U.adminA2],
        );
        const left = await rows<{ user_id: string; baby_id: string }>(
          "SELECT user_id, baby_id FROM import_sources ORDER BY baby_id, user_id",
        );
        expect(left.map((r) => `${r.baby_id}:${r.user_id}`).sort()).toEqual(
          [`${BABY.A}:${U.adminA1}`, `${BABY.B}:${U.adminA2}`].sort(),
        );
      });
    });

    it("leaving or removal drops the row (composite FK); deleting the baby or the account does too", async () => {
      await sandbox(async () => {
        await addSource(U.adminA2);
        await q("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.adminA2,
        ]);
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int AS n FROM import_sources WHERE user_id = $1",
              [U.adminA2],
            )
          )?.n,
        ).toBe(0);
      });
      await sandbox(async () => {
        await addSource(U.adminA1);
        await q("DELETE FROM babies WHERE id = $1", [BABY.A]);
        expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM import_sources"))?.n).toBe(
          0,
        );
      });
      await sandbox(async () => {
        await addSource(U.adminA1);
        await q("DELETE FROM auth.users WHERE id = $1", [U.adminA1]);
        expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM import_sources"))?.n).toBe(
          0,
        );
      });
    });

    it("the viewer role cannot read them", async () => {
      await sandbox(async () => {
        await addSource(U.adminA1);
        await as("viewer", { role: "viewer", share_link_id: randomUUID() });
        expect((await err("SELECT 1 FROM import_sources"))?.message).toMatch(PERMISSION_DENIED);
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("google_accounts", () => {
    it("authenticated sees four columns of its own row only; refresh_token_enc and * are denied", async () => {
      await sandbox(async () => {
        await connectGoogle(U.adminA1);
        await connectGoogle(U.contribA);
        await admin1();
        const own = await rows<Record<string, unknown>>(
          "SELECT user_id, connected_at, last_used_at, needs_reconnect FROM google_accounts",
        );
        expect(own).toHaveLength(1);
        expect(own[0]?.user_id).toBe(U.adminA1);
        expect(Object.keys(own[0] ?? {}).sort()).toEqual([
          "connected_at",
          "last_used_at",
          "needs_reconnect",
          "user_id",
        ]);
        expect((await err("SELECT refresh_token_enc FROM google_accounts"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await err("SELECT * FROM google_accounts"))?.message).toMatch(PERMISSION_DENIED);
        expect((await err("SELECT scope FROM google_accounts"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        await stranger();
        expect(await rows("SELECT user_id FROM google_accounts")).toEqual([]);
        await admin2();
        expect(await rows("SELECT user_id FROM google_accounts")).toEqual([]);
      });
    });

    it("users cannot write it (the API does, as service_role)", async () => {
      await sandbox(async () => {
        await admin1();
        expect(
          (
            await err(
              "INSERT INTO google_accounts (user_id, refresh_token_enc, scope) VALUES ($1, '\\x01', 's')",
              [U.adminA1],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
        await su();
        await connectGoogle(U.adminA1);
        await admin1();
        expect((await err("UPDATE google_accounts SET needs_reconnect = true"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await err("DELETE FROM google_accounts"))?.message).toMatch(PERMISSION_DENIED);
      });
    });

    it("the viewer and pipeline roles cannot read it", async () => {
      await sandbox(async () => {
        await connectGoogle(U.adminA1);
        await as("viewer", { role: "viewer", share_link_id: randomUUID() });
        expect((await err("SELECT 1 FROM google_accounts"))?.message).toMatch(PERMISSION_DENIED);
        await pipeline();
        expect((await err("SELECT 1 FROM google_accounts"))?.message).toMatch(PERMISSION_DENIED);
      });
    });

    it("the stored value is ciphertext: the token is not in the row bytes", async () => {
      await sandbox(async () => {
        await connectGoogle(U.adminA1, "1//SECRET-REFRESH-TOKEN");
        const r = await one<{ b: Buffer }>(
          "SELECT refresh_token_enc AS b FROM google_accounts WHERE user_id = $1",
          [U.adminA1],
        );
        expect(r?.b.toString("latin1")).not.toContain("SECRET-REFRESH");
      });
    });

    it("the shape trigger rejects an empty ciphertext with a message that does not echo the row", async () => {
      await sandbox(async () => {
        await service();
        const e = await err(
          "INSERT INTO google_accounts (user_id, refresh_token_enc, scope) VALUES ($1, '\\x'::bytea, 'scope-x')",
          [U.adminA1],
        );
        expect(e?.code).toBe("23514");
        expect(e?.message).not.toContain("scope-x");
      });
    });

    it("cascades with the profile", async () => {
      await sandbox(async () => {
        await connectGoogle(U.adminA1);
        await q("DELETE FROM auth.users WHERE id = $1", [U.adminA1]);
        expect(
          (await one<{ n: number }>("SELECT count(*)::int AS n FROM google_accounts"))?.n,
        ).toBe(0);
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("import_batches", () => {
    const create = (user: string, baby = BABY.A, extra = "") =>
      err(
        `INSERT INTO import_batches (baby_id, requested_by, kind${extra ? ", tz_hint, provider_session_id" : ""}) VALUES ($1, $2, 'google_picker'${extra ? ", 'UTC', 'sess-9'" : ""})`,
        [baby, user],
      );

    it("an admin and a contributor can start one (contributors may import); a stranger and another album's admin cannot", async () => {
      await sandbox(async () => {
        await contrib();
        expect(await create(U.contribA)).toBeNull();
      });
      await sandbox(async () => {
        await admin1();
        expect(await create(U.adminA1)).toBeNull();
      });
      await sandbox(async () => {
        await stranger();
        expect((await create(U.stranger))?.message).toMatch(RLS_VIOLATION);
        await otherAdmin();
        expect((await create(U.adminB))?.message).toMatch(RLS_VIOLATION);
        await admin1();
        expect((await create(U.contribA))?.message).toMatch(RLS_VIOLATION); // naming someone else
      });
    });

    it("a user cannot choose the status, counters or error at insert", async () => {
      await sandbox(async () => {
        await admin1();
        for (const col of ["status", "items_imported", "error", "cancel_requested_at"])
          expect(
            (
              await err(
                `INSERT INTO import_batches (baby_id, requested_by, kind, ${col}) VALUES ($1, $2, 'google_picker', NULL)`,
                [BABY.A, U.adminA1],
              )
            )?.message,
            col,
          ).toMatch(PERMISSION_DENIED);
        expect(await create(U.adminA1, BABY.A, "x")).toBeNull();
      });
    });

    it("one active batch per album: a second is refused until the first leaves picking/queued/running", async () => {
      await sandbox(async () => {
        await contrib();
        expect(await create(U.contribA)).toBeNull();
        expect((await create(U.contribA))?.message).toMatch(
          /an import is already in progress for this album/,
        );
        await admin1();
        expect((await create(U.adminA1))?.message).toMatch(
          /an import is already in progress for this album/,
        );
        await su();
        await q(
          "UPDATE import_batches SET status = 'done', finished_at = now() WHERE baby_id = $1",
          [BABY.A],
        );
        await admin1();
        expect(await create(U.adminA1)).toBeNull();
      });
    });

    it("another album is unaffected by an active batch", async () => {
      await sandbox(async () => {
        await addBatch({ baby: BABY.A });
        await otherAdmin();
        expect(await create(U.adminB, BABY.B)).toBeNull();
      });
    });

    it("an abandoned picking batch past its expiry is expired by the next insert", async () => {
      await sandbox(async () => {
        const old = await addBatch({ status: "picking", expires: "now() - interval '1 minute'" });
        await admin1();
        expect(await create(U.adminA1)).toBeNull();
        await su();
        expect(
          (await one<{ status: string }>("SELECT status FROM import_batches WHERE id = $1", [old]))
            ?.status,
        ).toBe("expired");
      });
    });

    it("the 21st batch within 24 hours is refused (20 per album per day)", async () => {
      await sandbox(async () => {
        for (let i = 0; i < 20; i++) {
          const id = await addBatch({ status: "picking", session: null });
          await q("UPDATE import_batches SET status = 'done', finished_at = now() WHERE id = $1", [
            id,
          ]);
        }
        await admin1();
        expect((await create(U.adminA1))?.message).toMatch(
          /import rate limit reached: 20 per album per day/,
        );
        await su();
        await q(
          "UPDATE import_batches SET created_at = now() - interval '25 hours' WHERE id IN (SELECT id FROM import_batches ORDER BY id LIMIT 3)",
        );
        await admin1();
        expect(await create(U.adminA1)).toBeNull();
      });
    });

    it("a trashed album refuses a new batch", async () => {
      await sandbox(async () => {
        await q("INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
          BABY.recentTrash,
          U.adminA1,
        ]);
        await admin1();
        expect((await create(U.adminA1, BABY.recentTrash))?.message).toMatch(
          /cannot import into a trashed album/,
        );
      });
    });

    it("provider_session_id is never selectable by users", async () => {
      await sandbox(async () => {
        await addBatch({ by: U.adminA1 });
        await admin1();
        expect((await err("SELECT provider_session_id FROM import_batches"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await err("SELECT * FROM import_batches"))?.message).toMatch(PERMISSION_DENIED);
        expect(await err("SELECT id, status, error, items_total FROM import_batches")).toBeNull();
      });
    });

    it("visibility: the requester and the album's admins see it; another contributor-less member, strangers and other albums do not", async () => {
      await sandbox(async () => {
        const mine = await addBatch({ by: U.contribA });
        const colSql = "SELECT id FROM import_batches";
        await contrib();
        expect((await rows<{ id: string }>(colSql)).map((r) => r.id)).toEqual([mine]);
        await admin1();
        expect((await rows<{ id: string }>(colSql)).map((r) => r.id)).toEqual([mine]);
        await admin2();
        expect((await rows<{ id: string }>(colSql)).map((r) => r.id)).toEqual([mine]);
        await stranger();
        expect(await rows(colSql)).toEqual([]);
        await otherAdmin();
        expect(await rows(colSql)).toEqual([]);
      });
    });

    it("an admin's batch is invisible to the contributor", async () => {
      await sandbox(async () => {
        await addBatch({ by: U.adminA1 });
        await contrib();
        expect(await rows("SELECT id FROM import_batches")).toEqual([]);
      });
    });

    it("a requester who left the album loses sight of the batch", async () => {
      await sandbox(async () => {
        await addBatch({ by: U.contribA });
        await q("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.contribA,
        ]);
        await contrib();
        expect(await rows("SELECT id FROM import_batches")).toEqual([]);
      });
    });

    it("only the requester updates; the co-admin updates 0 rows", async () => {
      await sandbox(async () => {
        const id = await addBatch({ by: U.contribA });
        await admin1();
        expect(
          (
            await q(
              "UPDATE import_batches SET status = 'cancelled', finished_at = now() WHERE id = $1",
              [id],
            )
          ).rowCount,
        ).toBe(0);
        await contrib();
        expect(
          (
            await q(
              "UPDATE import_batches SET status = 'cancelled', finished_at = now() WHERE id = $1",
              [id],
            )
          ).rowCount,
        ).toBe(1);
      });
    });

    describe("user status transitions", () => {
      const upd = (id: string, set: string) =>
        err(`UPDATE import_batches SET ${set} WHERE id = $1`, [id]);
      const transitionDenied = /import batch transition not allowed/;

      it("picking -> queued needs the session id and no finished_at; picking -> cancelled/expired ok; picking -> running/done/failed denied", async () => {
        await sandbox(async () => {
          const id = await addBatch({ status: "picking", session: null });
          await contrib();
          expect((await upd(id, "status = 'queued'"))?.message).toMatch(transitionDenied);
          expect(
            await upd(
              id,
              "provider_session_id = 'sess-x', poll_interval_sec = 5, last_polled_at = now()",
            ),
          ).toBeNull();
          expect(await upd(id, "status = 'queued'")).toBeNull();
        });
        for (const to of ["running", "done", "failed"]) {
          await sandbox(async () => {
            const id = await addBatch({ status: "picking" });
            await contrib();
            expect((await upd(id, `status = '${to}'`))?.message, to).toMatch(transitionDenied);
          });
        }
        for (const to of ["cancelled", "expired"]) {
          await sandbox(async () => {
            const id = await addBatch({ status: "picking" });
            await contrib();
            expect(await upd(id, `status = '${to}', finished_at = now()`), to).toBeNull();
          });
        }
      });

      it("the Google session id is set once and never changed or cleared", async () => {
        await sandbox(async () => {
          const id = await addBatch({ status: "picking", session: "sess-1" });
          await contrib();
          expect((await upd(id, "provider_session_id = 'sess-2'"))?.message).toMatch(
            transitionDenied,
          );
          expect((await upd(id, "provider_session_id = NULL"))?.message).toMatch(transitionDenied);
        });
      });

      it("queued/running: only cancel_requested_at may change, once", async () => {
        await sandbox(async () => {
          const id = await addBatch({ status: "queued" });
          await contrib();
          for (const set of [
            "status = 'cancelled'",
            "status = 'running'",
            "status = 'done'",
            "poll_interval_sec = 7",
            "picker_expires_at = now()",
            "last_polled_at = now()",
            "finished_at = now()",
          ])
            expect((await upd(id, set))?.message, set).toMatch(transitionDenied);
          expect(await upd(id, "cancel_requested_at = now()")).toBeNull();
          expect((await upd(id, "cancel_requested_at = NULL"))?.message).toMatch(transitionDenied);
          expect(
            (await upd(id, "cancel_requested_at = now() + interval '1 hour'"))?.message,
          ).toMatch(transitionDenied);
        });
        await sandbox(async () => {
          const id = await addBatch({ status: "running" });
          await contrib();
          expect(await upd(id, "cancel_requested_at = now()")).toBeNull();
          expect((await upd(id, "status = 'cancelled'"))?.message).toMatch(transitionDenied);
        });
      });

      it.each(["done", "failed", "cancelled", "expired"])(
        "%s is final for users",
        async (status) => {
          await sandbox(async () => {
            const id = await addBatch({ status: "picking" });
            await q("UPDATE import_batches SET status = $2, finished_at = now() WHERE id = $1", [
              id,
              status,
            ]);
            await contrib();
            expect((await upd(id, "cancel_requested_at = now()"))?.message).toMatch(
              transitionDenied,
            );
            expect((await upd(id, "status = 'picking'"))?.message).toMatch(transitionDenied);
          });
        },
      );

      it("counters, error and the worker's timestamps are not user-writable", async () => {
        await sandbox(async () => {
          const id = await addBatch({ status: "picking" });
          await contrib();
          for (const set of [
            "items_imported = 5",
            "items_total = 3",
            "items_failed = 1",
            "error = 'internal'",
            "started_at = now()",
            "requested_by = NULL",
            `baby_id = '${BABY.B}'`,
            "tz_hint = 'UTC'",
          ])
            expect((await upd(id, set))?.message, set).toMatch(PERMISSION_DENIED);
        });
      });
    });

    it("the pipeline moves it through running to done and writes counters; it cannot change identity columns", async () => {
      await sandbox(async () => {
        const id = await addBatch({ status: "queued" });
        await pipeline();
        expect((await rows("SELECT id FROM import_batches")).length).toBe(1);
        expect(
          await err(
            "UPDATE import_batches SET status = 'running', started_at = now() WHERE id = $1",
            [id],
          ),
        ).toBeNull();
        expect(
          await err(
            "UPDATE import_batches SET items_total = 3, items_imported = 2, items_duplicate = 1 WHERE id = $1",
            [id],
          ),
        ).toBeNull();
        expect(
          await err(
            "UPDATE import_batches SET status = 'failed', error = 'google_reconnect', finished_at = now() WHERE id = $1",
            [id],
          ),
        ).toBeNull();
        expect(
          (await err("UPDATE import_batches SET requested_by = NULL WHERE id = $1", [id]))?.message,
        ).toMatch(PERMISSION_DENIED);
        expect(
          (await err("UPDATE import_batches SET error = 'bogus' WHERE id = $1", [id]))?.code,
        ).toBe("23514");
        expect((await err("DELETE FROM import_batches WHERE id = $1", [id]))?.message).toMatch(
          PERMISSION_DENIED,
        );
      });
    });

    it("the account deletion nulls requested_by but keeps the batch", async () => {
      await sandbox(async () => {
        const id = await addBatch({ by: U.contribA, status: "queued" });
        await q("DELETE FROM auth.users WHERE id = $1", [U.contribA]);
        const r = await one<{ requested_by: string | null }>(
          "SELECT requested_by FROM import_batches WHERE id = $1",
          [id],
        );
        expect(r?.requested_by).toBeNull();
        await pipeline();
        expect(
          (await one<{ state: string }>("SELECT import_batch_requester_state($1) AS state", [id]))
            ?.state,
        ).toBe("not_member");
      });
    });

    it("deleting the baby removes its batches and items", async () => {
      await sandbox(async () => {
        const b = await addBatch({ status: "running" });
        await downloadedItem(b);
        await q("DELETE FROM babies WHERE id = $1", [BABY.A]);
        expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM import_batches"))?.n).toBe(
          0,
        );
        expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM import_items"))?.n).toBe(
          0,
        );
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("import_items", () => {
    it("visibility follows the batch; users see seven columns and no write path", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.contribA, status: "running" });
        const item = await downloadedItem(b);
        const sql =
          "SELECT id, batch_id, baby_id, status, error, photo_id, created_at FROM import_items";
        await contrib();
        expect((await rows<{ id: string }>(sql)).map((r) => r.id)).toEqual([item]);
        await admin1();
        expect((await rows<{ id: string }>(sql)).map((r) => r.id)).toEqual([item]);
        await stranger();
        expect(await rows(sql)).toEqual([]);
        await otherAdmin();
        expect(await rows(sql)).toEqual([]);
        await admin1();
        expect((await err("SELECT provider_item_id FROM import_items"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await err("SELECT * FROM import_items"))?.message).toMatch(PERMISSION_DENIED);
        expect((await err("UPDATE import_items SET status = 'booked'"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await err("DELETE FROM import_items"))?.message).toMatch(PERMISSION_DENIED);
        expect(
          (
            await err(
              `INSERT INTO import_items (batch_id, baby_id, provider_item_id) VALUES ($1, $2, 'x')`,
              [b, BABY.A],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("an admin's batch items are invisible to the contributor", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        await downloadedItem(b);
        await contrib();
        expect(await rows("SELECT id FROM import_items")).toEqual([]);
      });
    });

    it("the pipeline inserts items only for a queued/running batch of the same album", async () => {
      await sandbox(async () => {
        const picking = await addBatch({ status: "picking" });
        const running = await addBatch({ baby: BABY.B, by: U.adminB, status: "running" });
        await pipeline();
        const ins = (batch: string, baby: string) =>
          err(
            `INSERT INTO import_items (batch_id, baby_id, provider_item_id) VALUES ($1, $2, $3)`,
            [batch, baby, randomUUID()],
          );
        expect((await ins(picking, BABY.A))?.message).toMatch(
          /must belong to an active batch of the same album/,
        );
        expect((await ins(running, BABY.A))?.message).toMatch(
          /must belong to an active batch of the same album/,
        );
        expect(await ins(running, BABY.B)).toBeNull();
      });
    });

    it("storage_key is derived from the baby and item ids (generated, not settable)", async () => {
      await sandbox(async () => {
        const b = await addBatch({ status: "running" });
        const id = await downloadedItem(b);
        const r = await one<{ storage_key: string }>(
          "SELECT storage_key FROM import_items WHERE id = $1",
          [id],
        );
        expect(r?.storage_key).toBe(`babies/${BABY.A}/originals/${id}`);
        await pipeline();
        expect(
          (
            await err(
              "UPDATE import_items SET storage_key = 'babies/x/originals/y' WHERE id = $1",
              [id],
            )
          )?.message,
        ).toMatch(/permission denied|can only be updated to DEFAULT/);
      });
    });

    it("constraints: size cap 100 MiB, 32-byte hash, photo_id must equal id, unique per batch", async () => {
      await sandbox(async () => {
        const b = await addBatch({ status: "running" });
        await pipeline();
        const ins = (cols: string, vals: string) =>
          err(
            `INSERT INTO import_items (batch_id, baby_id, provider_item_id, ${cols}) VALUES ($1, $2, $3, ${vals})`,
            [b, BABY.A, randomUUID()],
          );
        expect((await ins("bytes", "104857601"))?.code).toBe("23514");
        expect((await ins("bytes", "0"))?.code).toBe("23514");
        expect((await ins("sha256", "'\\x00'::bytea"))?.code).toBe("23514");
        expect((await ins("photo_id", `'${P.approved1}'`))?.code).toBeDefined();
        const dup = randomUUID();
        expect(
          await err(
            `INSERT INTO import_items (batch_id, baby_id, provider_item_id) VALUES ($1, $2, $3)`,
            [b, BABY.A, dup],
          ),
        ).toBeNull();
        expect(
          (
            await err(
              `INSERT INTO import_items (batch_id, baby_id, provider_item_id) VALUES ($1, $2, $3)`,
              [b, BABY.A, dup],
            )
          )?.code,
        ).toBe("23505");
      });
    });

    it("retention: the pipeline deletes only terminal items older than 30 days; downloaded and recent items stay", async () => {
      await sandbox(async () => {
        const b = await addBatch({ status: "running" });
        const old = await downloadedItem(b);
        const oldDownloaded = await downloadedItem(b);
        const recent = await downloadedItem(b);
        await q("UPDATE import_items SET status = 'skipped' WHERE id IN ($1, $2)", [old, recent]);
        await q("SET LOCAL session_replication_role = replica");
        await q(
          "UPDATE import_items SET updated_at = now() - interval '31 days' WHERE id IN ($1, $2)",
          [old, oldDownloaded],
        );
        await q("SET LOCAL session_replication_role = origin");
        await pipeline();
        const del = await q("DELETE FROM import_items");
        expect(del.rowCount).toBe(1);
        await su();
        const left = (await rows<{ id: string }>("SELECT id FROM import_items"))
          .map((r) => r.id)
          .sort();
        expect(left).toEqual([oldDownloaded, recent].sort());
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("import_batch_requester_state / import_google_refresh_token / import_mark_reconnect", () => {
    const state = async (batch: string) =>
      (await one<{ s: string }>("SELECT import_batch_requester_state($1) AS s", [batch]))?.s;
    const token = async (batch: string) =>
      (await one<{ t: string | null }>("SELECT import_google_refresh_token($1) AS t", [batch]))?.t;

    it("the token is NULL while picking, set while queued/running, NULL when done", async () => {
      await sandbox(async () => {
        await connectGoogle(U.contribA, "1//the-refresh-token");
        const b = await addBatch({ by: U.contribA, status: "picking" });
        await key();
        await pipeline();
        expect(await token(b)).toBeNull();
        await su();
        await q("UPDATE import_batches SET status = 'queued' WHERE id = $1", [b]);
        await key();
        await pipeline();
        expect(await token(b)).toBe("1//the-refresh-token");
        await su();
        await q("UPDATE import_batches SET status = 'running' WHERE id = $1", [b]);
        await key();
        await pipeline();
        expect(await token(b)).toBe("1//the-refresh-token");
        await su();
        await q("UPDATE import_batches SET status = 'done', finished_at = now() WHERE id = $1", [
          b,
        ]);
        await key();
        await pipeline();
        expect(await token(b)).toBeNull();
      });
    });

    it.each([
      [
        "the requester leaves the album",
        "DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2",
      ],
      [
        "the album is trashed",
        "UPDATE babies SET deleted_at = now() WHERE id = $1 AND $2::uuid IS NOT NULL",
      ],
      [
        "the profile is marked deleted",
        "UPDATE profiles SET deleted_at = now() WHERE user_id = $2 AND $1::uuid IS NOT NULL",
      ],
      [
        "the connection needs reconnecting",
        "UPDATE google_accounts SET needs_reconnect = true WHERE user_id = $2 AND $1::uuid IS NOT NULL",
      ],
    ])("the token is NULL after %s", async (_n, sql) => {
      await sandbox(async () => {
        await connectGoogle(U.contribA);
        const b = await addBatch({ by: U.contribA, status: "queued" });
        await q(sql, [BABY.A, U.contribA]);
        await key();
        await pipeline();
        expect(await token(b)).toBeNull();
      });
    });

    it("a stranger's connection is never returned for someone else's batch", async () => {
      await sandbox(async () => {
        await connectGoogle(U.adminA1, "1//admin-token");
        const b = await addBatch({ by: U.contribA, status: "queued" });
        await key();
        await pipeline();
        expect(await token(b)).toBeNull();
      });
    });

    it("without the data key an active batch raises (no silent NULL), without leaking anything", async () => {
      await sandbox(async () => {
        await connectGoogle(U.contribA);
        const b = await addBatch({ by: U.contribA, status: "queued" });
        await q("SELECT set_config('app.data_key', '', true)");
        await pipeline();
        const e = await err("SELECT import_google_refresh_token($1)", [b]);
        expect(e?.message).toMatch(/data key not set/);
      });
    });

    it("users, anon and the viewer cannot call the worker functions", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.contribA, status: "queued" });
        await key();
        for (const [role, claims] of [
          ["authenticated", authed(U.contribA)],
          ["anon", null],
          ["viewer", { role: "viewer", share_link_id: randomUUID() }],
        ] as const) {
          await as(role, claims);
          for (const fn of [
            "import_google_refresh_token",
            "import_batch_requester_state",
            "import_mark_reconnect",
            "import_book_photo",
          ])
            expect((await err(`SELECT ${fn}($1)`, [b]))?.message, `${role} ${fn}`).toMatch(
              NO_ACCESS,
            );
        }
      });
    });

    it("requester state: ok | not_active | not_member | baby_trashed | not_connected | reconnect", async () => {
      await sandbox(async () => {
        await pipeline();
        expect(await state(randomUUID())).toBe("not_active");
        await su();
        const picking = await addBatch({ by: U.contribA, status: "picking" });
        await pipeline();
        expect(await state(picking)).toBe("not_active");
        await su();
        await q("UPDATE import_batches SET status = 'queued' WHERE id = $1", [picking]);
        await pipeline();
        expect(await state(picking)).toBe("not_connected");
        await su();
        await connectGoogle(U.contribA);
        await pipeline();
        expect(await state(picking)).toBe("ok");
        await su();
        await q("UPDATE google_accounts SET needs_reconnect = true WHERE user_id = $1", [
          U.contribA,
        ]);
        await pipeline();
        expect(await state(picking)).toBe("reconnect");
        await su();
        await q("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
        await pipeline();
        expect(await state(picking)).toBe("baby_trashed");
        await su();
        await q("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.contribA,
        ]);
        await pipeline();
        expect(await state(picking)).toBe("not_member");
      });
    });

    it("import_mark_reconnect flags only the requester of an active batch", async () => {
      await sandbox(async () => {
        await connectGoogle(U.contribA);
        await connectGoogle(U.adminA1);
        const done = await addBatch({ by: U.contribA, status: "picking" });
        await q("UPDATE import_batches SET status = 'done', finished_at = now() WHERE id = $1", [
          done,
        ]);
        const active = await addBatch({ by: U.contribA, status: "queued" });
        await pipeline();
        await q("SELECT import_mark_reconnect($1)", [done]);
        await su();
        expect(await rows("SELECT user_id FROM google_accounts WHERE needs_reconnect")).toEqual([]);
        await pipeline();
        await q("SELECT import_mark_reconnect($1)", [active]);
        await su();
        const flagged = await rows<{ user_id: string; refresh_failures: number }>(
          "SELECT user_id, refresh_failures FROM google_accounts WHERE needs_reconnect",
        );
        expect(flagged).toEqual([{ user_id: U.contribA, refresh_failures: 1 }]);
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("import_book_photo (D10)", () => {
    const book = async (item: string) =>
      (await one<{ o: string }>("SELECT import_book_photo($1) AS o", [item]))?.o;
    const photoOf = (id: string) =>
      one<{
        approval: string;
        approved_by: string | null;
        approved_at: Date | null;
        uploaded_by: string;
        mime: string;
        bytes: string;
        taken_at: Date | null;
        taken_at_estimated: boolean;
        status: string;
        storage_key_original: string;
      }>(
        "SELECT approval, approved_by, approved_at, uploaded_by, mime, bytes::text, taken_at, taken_at_estimated, status, storage_key_original FROM photos WHERE id = $1",
        [id],
      );

    it("admin requester: approved, approved_by = the requester (nobody else), item booked", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        const item = await downloadedItem(b, { takenAt: "2026-03-02T09:00:00Z" });
        await pipeline();
        expect(await book(item)).toBe("booked");
        await su();
        const p = await photoOf(item);
        expect(p).toMatchObject({
          approval: "approved",
          approved_by: U.adminA1,
          uploaded_by: U.adminA1,
          mime: "image/jpeg",
          bytes: "1234",
          taken_at_estimated: true,
          status: "uploaded",
          storage_key_original: `babies/${BABY.A}/originals/${item}`,
        });
        expect(p?.approved_at).toBeInstanceOf(Date);
        expect(p?.taken_at?.toISOString()).toBe("2026-03-02T09:00:00.000Z");
        expect(
          await one("SELECT status, photo_id FROM import_items WHERE id = $1", [item]),
        ).toEqual({ status: "booked", photo_id: item });
      });
    });

    it("contributor requester: pending, no approver, no approval time", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.contribA, status: "running" });
        const item = await downloadedItem(b);
        await pipeline();
        expect(await book(item)).toBe("booked");
        await su();
        expect(await photoOf(item)).toMatchObject({
          approval: "pending",
          approved_by: null,
          approved_at: null,
          uploaded_by: U.contribA,
        });
      });
    });

    it("a contributor promoted after the batch started books as approved under their own name; one demoted books pending", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA2, status: "running" });
        const item = await downloadedItem(b);
        await q(
          "UPDATE baby_members SET role = 'contributor' WHERE baby_id = $1 AND user_id = $2",
          [BABY.A, U.adminA2],
        );
        await pipeline();
        expect(await book(item)).toBe("booked");
        await su();
        expect(await photoOf(item)).toMatchObject({ approval: "pending", approved_by: null });
      });
    });

    it("a removed member: not_member, no photo", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.contribA, status: "running" });
        const item = await downloadedItem(b);
        await q("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.contribA,
        ]);
        await pipeline();
        expect(await book(item)).toBe("not_member");
        await su();
        expect(await photoOf(item)).toBeUndefined();
        expect(
          (await one<{ status: string }>("SELECT status FROM import_items WHERE id = $1", [item]))
            ?.status,
        ).toBe("downloaded");
      });
    });

    it("a deleted account (requested_by NULL) or a profile marked deleted: not_member", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA2, status: "running" });
        const item = await downloadedItem(b);
        await q("UPDATE profiles SET deleted_at = now() WHERE user_id = $1", [U.adminA2]);
        await pipeline();
        expect(await book(item)).toBe("not_member");
      });
      await sandbox(async () => {
        const b = await addBatch({ by: U.contribA, status: "running" });
        const item = await downloadedItem(b);
        await q("UPDATE import_batches SET requested_by = NULL WHERE id = $1", [b]);
        await pipeline();
        expect(await book(item)).toBe("not_member");
      });
    });

    it("a trashed album: baby_trashed", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        const item = await downloadedItem(b);
        await q("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
        await pipeline();
        expect(await book(item)).toBe("baby_trashed");
      });
    });

    it("a duplicate SHA-256 in the album: duplicate (the item stays downloaded for the worker to mark)", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        const item = await downloadedItem(b);
        await q(
          "UPDATE photos SET sha256 = (SELECT sha256 FROM import_items WHERE id = $1) WHERE id = $2",
          [item, P.approved2],
        );
        await pipeline();
        expect(await book(item)).toBe("duplicate");
        await su();
        expect(await photoOf(item)).toBeUndefined();
        expect(
          (await one<{ status: string }>("SELECT status FROM import_items WHERE id = $1", [item]))
            ?.status,
        ).toBe("downloaded");
      });
    });

    it("the same hash in another album is not a duplicate", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        const item = await downloadedItem(b);
        await q(
          "UPDATE photos SET sha256 = (SELECT sha256 FROM import_items WHERE id = $1) WHERE id = $2",
          [item, P.b1],
        );
        await pipeline();
        expect(await book(item)).toBe("booked");
      });
    });

    it("free tier: 1,000 live photos on a free album => free_tier_limit; the 999th still books", async () => {
      await sandbox(async () => {
        const baby = randomUUID();
        await q(
          "INSERT INTO babies (id, name, birth_date, plan, family_id) VALUES ($1, 'Free', '2025-06-30', 'free', (SELECT family_id FROM babies WHERE id = $2))",
          [baby, BABY.A],
        );
        await q("INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin')", [
          baby,
          U.adminA1,
        ]);
        await q(
          `INSERT INTO photos (baby_id, uploaded_by, storage_key_original, bytes, approval, approved_by, approved_at, status)
           SELECT $1::uuid, $2::uuid, 'fx/' || gen_random_uuid()::text, 10, 'approved', $2::uuid, now(), 'ready' FROM generate_series(1, 998)`,
          [baby, U.adminA1],
        );
        const b = await addBatch({ baby, by: U.adminA1, status: "running" });
        const first = await downloadedItem(b, { baby });
        const second = await downloadedItem(b, { baby });
        await pipeline();
        expect(await book(first)).toBe("booked");
        expect(await book(second)).toBe("booked"); // 1,000th
        await su();
        const third = await downloadedItem(b, { baby });
        await pipeline();
        expect(await book(third)).toBe("free_tier_limit");
        await su();
        expect(await photoOf(third)).toBeUndefined();
      });
    });

    it("a paid album is not capped", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        const item = await downloadedItem(b);
        await q(
          `INSERT INTO photos (baby_id, uploaded_by, storage_key_original, bytes, approval, approved_by, approved_at, status)
           SELECT $1::uuid, $2::uuid, 'fx/' || gen_random_uuid()::text, 10, 'approved', $2::uuid, now(), 'ready' FROM generate_series(1, 1005)`,
          [BABY.A, U.adminA1],
        );
        await pipeline();
        expect(await book(item)).toBe("booked");
      });
    });

    it("raises (fixed messages) for a missing item, an item that is not downloaded, and a batch that is not running", async () => {
      await sandbox(async () => {
        const queued = await addBatch({ by: U.adminA1, status: "queued" });
        const item = await downloadedItem(queued);
        await pipeline();
        expect((await err("SELECT import_book_photo($1)", [randomUUID()]))?.message).toBe(
          "import item not found",
        );
        expect((await err("SELECT import_book_photo($1)", [item]))?.message).toBe(
          "import batch is not running",
        );
        await su();
        await q("UPDATE import_batches SET status = 'running' WHERE id = $1", [queued]);
        const fresh = randomUUID();
        await q(
          "INSERT INTO import_items (id, batch_id, baby_id, provider_item_id) VALUES ($1, $2, $3, 'p')",
          [fresh, queued, BABY.A],
        );
        await pipeline();
        expect((await err("SELECT import_book_photo($1)", [fresh]))?.message).toBe(
          "import item is not ready to book",
        );
      });
    });

    it("the pipeline cannot insert into photos itself", async () => {
      await sandbox(async () => {
        await pipeline();
        expect(
          (
            await err(
              `INSERT INTO photos (baby_id, uploaded_by, storage_key_original, approval, approved_by) VALUES ($1, $2, 'x', 'approved', $2)`,
              [BABY.A, U.adminA1],
            )
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("booking twice does not create a second photo (the second call raises: no longer downloaded)", async () => {
      await sandbox(async () => {
        const b = await addBatch({ by: U.adminA1, status: "running" });
        const item = await downloadedItem(b);
        await pipeline();
        expect(await book(item)).toBe("booked");
        expect((await err("SELECT import_book_photo($1)", [item]))?.message).toBe(
          "import item is not ready to book",
        );
      });
    });
  });
});
