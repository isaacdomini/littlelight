import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @littlelight/shared: relative import on purpose.
import { FREE_TIER_PHOTO_LIMIT, HOME_RADIUS_M } from "../shared/src/constants";
import { UPLOAD_MAX_FILES_PER_SESSION as MAX_FILES_PER_SESSION } from "../shared/src/upload";
import { BABY, createFixtures, dropFixtures, LINK, P, U } from "./test/fixtures";
import {
  connect,
  DATA_KEY,
  type Db,
  databaseUrl,
  ensureMigrated,
  PERMISSION_DENIED,
  tryQuery,
} from "./test/harness";

// Step 4 database rules (docs/plans/step-4.md 2.3, 2.13; packages/db/README.md "Uploads and ingest
// (step 4)"): upload_sessions / upload_files RLS and triggers, the pipeline's column grants, the
// transient 'duplicate' marker, quarantine, home_place_label, the free-tier cap predicate and the
// baby purge guard. Role cases run on rolled-back transactions against rows committed here (ids
// `e<k>...`, removed in afterAll); superuser-only cases use a rolled-back sandbox.

const id = (kind: number, n: number) =>
  `e${kind}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const HOME_BABY = id(2, 1); // plus plan, home at 47.6062 / -122.3321
const NO_HOME_BABY = id(2, 2);
const FREE_BABY = id(2, 3); // free plan, adminA1 admin + contribA contributor
const QUAR_BABY = id(2, 4); // trashed 31 days, holds a quarantined photo
const CLEAN_OLD_BABY = id(2, 5); // trashed 31 days, no quarantined photo

const S = {
  admin: id(3, 1), // baby A, by adminA1
  contrib: id(3, 2), // baby A, by contribA
  other: id(3, 3), // baby B, by adminB
  expired: id(3, 4), // baby A, by contribA, expired
  finished: id(3, 5), // baby A, by contribA, finished
  full: id(3, 6), // baby A, by contribA, 500 files
} as const;
const F = {
  admin: id(4, 1),
  contrib: id(4, 2),
  other: id(4, 3),
} as const;
const QP = id(5, 1); // quarantined, approved photo of baby A, shared on LA
const QP_OWN = id(5, 2); // quarantined, pending photo uploaded by contribA
const QP_BABY = id(5, 3); // quarantined photo of QUAR_BABY

let n = 0;
const key = () => `e-db/${++n}/${Math.random().toString(36).slice(2)}`;

describe.skipIf(!databaseUrl)("uploads and ingest (step 4 database rules)", () => {
  let db: Db;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
  const err = (sql: string, params: unknown[] = []) => tryQuery(db.admin, sql, params);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0] as T;
  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await q("BEGIN");
    try {
      return await fn();
    } finally {
      await q("ROLLBACK");
    }
  }

  const insertFile = (fileId: string, sessionId: string, baby: string): Promise<unknown> =>
    q(
      `INSERT INTO upload_files (id, session_id, baby_id, declared_bytes, storage_key, part_size)
       VALUES ($1, $2, $3, 1000, $4, 8388608)`,
      [fileId, sessionId, baby, key()],
    );
  const fileSql = (fid: string, sid: string, baby: string) => [
    `INSERT INTO upload_files (id, session_id, baby_id, declared_bytes, storage_key, part_size)
     VALUES ($1, $2, $3, 1000, $4, 8388608)`,
    [fid, sid, baby, key()],
  ];

  const insertPhoto = (
    photoId: string,
    baby: string,
    opts: {
      status?: string;
      deleted?: string; // interval
      quarantined?: boolean;
      approval?: string;
      by?: string;
    } = {},
  ) =>
    q(
      `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, status, approval, deleted_at, quarantined_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${opts.deleted ? `now() - interval '${opts.deleted}'` : "NULL"},
               ${opts.quarantined ? "now()" : "NULL"})`,
      [
        photoId,
        baby,
        opts.by ?? U.adminA1,
        key(),
        opts.status ?? "ingested",
        opts.approval ?? "approved",
      ],
    );

  const cleanup = async () => {
    await q("DELETE FROM babies WHERE id = ANY($1::uuid[])", [
      [HOME_BABY, NO_HOME_BABY, FREE_BABY, QUAR_BABY, CLEAN_OLD_BABY],
    ]);
    await q("DELETE FROM upload_sessions WHERE id = ANY($1::uuid[])", [Object.values(S)]);
    await q("DELETE FROM photos WHERE id = ANY($1::uuid[])", [[QP, QP_OWN, QP_BABY]]);
  };

  beforeAll(async () => {
    await ensureMigrated();
    db = await connect();
    await createFixtures(db.admin);
    await cleanup();

    await q("SELECT set_config('app.data_key', $1, false)", [DATA_KEY]);
    await q(
      `INSERT INTO babies (id, name, birth_date, plan, home_lat_enc, home_lng_enc)
       VALUES ($1, 'Home', '2025-06-30', 'plus', encrypt_coord(47.6062), encrypt_coord(-122.3321))`,
      [HOME_BABY],
    );
    await q("SELECT set_config('app.data_key', '', false)");
    await q(
      `INSERT INTO babies (id, name, birth_date, plan) VALUES ($1, 'NoHome', '2025-06-30', 'plus')`,
      [NO_HOME_BABY],
    );
    await q(
      `INSERT INTO babies (id, name, birth_date, plan) VALUES ($1, 'Free', '2025-06-30', 'free')`,
      [FREE_BABY],
    );
    await q(
      `INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'contributor')`,
      [FREE_BABY, U.adminA1, U.contribA],
    );
    await q(
      `INSERT INTO babies (id, name, birth_date, plan, deleted_at)
       VALUES ($1, 'Q', '2025-06-30', 'plus', now() - interval '31 days'),
              ($2, 'C', '2025-06-30', 'plus', now() - interval '31 days')`,
      [QUAR_BABY, CLEAN_OLD_BABY],
    );
    await insertPhoto(QP_BABY, QUAR_BABY, { quarantined: true, status: "failed" });
    await insertPhoto(id(5, 4), CLEAN_OLD_BABY);

    // Free-tier counting world: pending counts, failed / duplicate / trashed / quarantined do not.
    await insertPhoto(id(6, 1), FREE_BABY, { status: "ready" });
    await insertPhoto(id(6, 2), FREE_BABY, {
      status: "uploaded",
      approval: "pending",
      by: U.contribA,
    });
    await insertPhoto(id(6, 3), FREE_BABY, {
      status: "ingested",
      approval: "pending",
      by: U.adminA1,
    });
    await insertPhoto(id(6, 4), FREE_BABY, { status: "failed" });
    await insertPhoto(id(6, 5), FREE_BABY, { status: "duplicate" });
    await insertPhoto(id(6, 6), FREE_BABY, { deleted: "1 hour" });
    await insertPhoto(id(6, 7), FREE_BABY, { quarantined: true });

    for (const [sid, baby, by, extra] of [
      [S.admin, BABY.A, U.adminA1, ""],
      [S.contrib, BABY.A, U.contribA, ""],
      [S.other, BABY.B, U.adminB, ""],
      [S.expired, BABY.A, U.contribA, ", expires_at"],
      [S.finished, BABY.A, U.contribA, ", finished_at"],
      [S.full, BABY.A, U.contribA, ""],
    ] as const) {
      const extraVal =
        sid === S.expired ? ", now() - interval '1 minute'" : sid === S.finished ? ", now()" : "";
      await q(
        `INSERT INTO upload_sessions (id, baby_id, created_by, note, people ${extra})
         VALUES ($1, $2, $3, 'private batch note', '{Dad}' ${extraVal})`,
        [sid, baby, by],
      );
    }
    await q(
      `INSERT INTO upload_files (id, session_id, baby_id, declared_bytes, storage_key, part_size)
       SELECT gen_random_uuid(), $1, $2, 1000, 'e-db/full/' || g, 8388608 FROM generate_series(1, 500) g`,
      [S.full, BABY.A],
    );
    await insertFile(F.admin, S.admin, BABY.A);
    await insertFile(F.contrib, S.contrib, BABY.A);
    await insertFile(F.other, S.other, BABY.B);

    // Quarantined, approved, shared photo with every kind of child row.
    await insertPhoto(QP, BABY.A, { quarantined: true });
    await insertPhoto(QP_OWN, BABY.A, { quarantined: true, approval: "pending", by: U.contribA });
    await q("SELECT set_config('app.data_key', $1, false)", [DATA_KEY]);
    for (const p of [QP, QP_OWN]) {
      await q(
        `INSERT INTO photo_derivatives (photo_id, kind, storage_key, width, height, bytes) VALUES ($1, 'thumb', $2, 1, 1, 1)`,
        [p, key()],
      );
      await q(`INSERT INTO photo_exif (photo_id, place_label) VALUES ($1, 'Somewhere')`, [p]);
      await q(`INSERT INTO photo_details (photo_id, note, edited_by) VALUES ($1, 'n', $2)`, [
        p,
        U.adminA1,
      ]);
    }
    await q("SELECT set_config('app.data_key', '', false)");
    await q(
      `INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)`,
      [LINK.LA, QP, U.adminA1],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await dropFixtures(db.admin);
    await db.close();
  });

  it("shared constants match the migration (cap 1000, 500 files, 150 m)", () => {
    expect(FREE_TIER_PHOTO_LIMIT).toBe(1000);
    expect(MAX_FILES_PER_SESSION).toBe(500);
    expect(HOME_RADIUS_M).toBe(150);
  });

  describe("upload_sessions / upload_files visibility", () => {
    it("a stranger sees 0 rows on both tables", async () => {
      await db.asUser(U.stranger, async (c) => {
        expect((await c.query("SELECT 1 FROM upload_sessions")).rowCount).toBe(0);
        expect((await c.query("SELECT 1 FROM upload_files")).rowCount).toBe(0);
      });
    });

    it("a member of the other baby sees only their own baby's sessions", async () => {
      await db.asUser(U.adminB, async (c) => {
        const r = await c.query("SELECT id FROM upload_sessions");
        expect(r.rows.map((x) => x.id)).toEqual([S.other]);
        const f = await c.query("SELECT id FROM upload_files");
        expect(f.rows.map((x) => x.id)).toEqual([F.other]);
      });
    });

    it("a contributor sees their own sessions and files, not the admin's", async () => {
      await db.asUser(U.contribA, async (c) => {
        const s = await c.query("SELECT id FROM upload_sessions");
        expect(s.rows.map((x) => x.id).sort()).toEqual(
          [S.contrib, S.expired, S.finished, S.full].sort(),
        );
        const f = await c.query("SELECT id FROM upload_files WHERE session_id = $1", [S.admin]);
        expect(f.rowCount).toBe(0);
        const mine = await c.query("SELECT id FROM upload_files WHERE id = $1", [F.contrib]);
        expect(mine.rowCount).toBe(1);
      });
    });

    it("an admin sees every session of the baby (and its files), never another baby's", async () => {
      await db.asUser(U.adminA2, async (c) => {
        const s = await c.query("SELECT id FROM upload_sessions");
        const ids = s.rows.map((x) => x.id);
        expect(ids).toEqual(expect.arrayContaining([S.admin, S.contrib]));
        expect(ids).not.toContain(S.other);
        const f = await c.query("SELECT id FROM upload_files WHERE id = ANY($1)", [
          [F.admin, F.contrib, F.other],
        ]);
        expect(f.rows.map((x) => x.id).sort()).toEqual([F.admin, F.contrib].sort());
      });
    });

    it("the viewer role has no access to either table nor to the new helpers", async () => {
      await db.asViewer(LINK.LA, async (c) => {
        for (const sql of [
          "SELECT 1 FROM upload_sessions",
          "SELECT 1 FROM upload_files",
          `SELECT home_place_label('${BABY.A}'::uuid, 1.0::float8, 1.0::float8)`,
          `SELECT upload_session_visible('${S.admin}')`,
          `SELECT free_tier_photo_count('${BABY.A}')`,
          `SELECT baby_has_quarantined_photos('${BABY.A}')`,
        ]) {
          const e = await tryQuery(c, sql);
          expect(e?.message, sql).toMatch(PERMISSION_DENIED);
        }
      });
    });

    it("authenticated cannot execute the pipeline-only helpers", async () => {
      await db.asUser(U.adminA1, async (c) => {
        for (const sql of [
          `SELECT home_place_label('${BABY.A}'::uuid, 1.0::float8, 1.0::float8)`,
          `SELECT baby_has_quarantined_photos('${BABY.A}')`,
        ]) {
          expect((await tryQuery(c, sql))?.message, sql).toMatch(PERMISSION_DENIED);
        }
      });
    });

    it("helper grants: execute is limited to the documented roles", async () => {
      const r = await one<Record<string, boolean>>(
        `SELECT has_function_privilege('authenticated', 'free_tier_photo_count(uuid)', 'EXECUTE') AS ft_auth,
                has_function_privilege('viewer', 'free_tier_photo_count(uuid)', 'EXECUTE') AS ft_viewer,
                has_function_privilege('pipeline', 'free_tier_photo_count(uuid)', 'EXECUTE') AS ft_pipe,
                has_function_privilege('authenticated', 'upload_session_visible(uuid)', 'EXECUTE') AS us_auth,
                has_function_privilege('viewer', 'upload_session_visible(uuid)', 'EXECUTE') AS us_viewer,
                has_function_privilege('pipeline', 'home_place_label(uuid,double precision,double precision)', 'EXECUTE') AS h_pipe,
                has_function_privilege('authenticated', 'home_place_label(uuid,double precision,double precision)', 'EXECUTE') AS h_auth,
                has_function_privilege('pipeline', 'home_place_label(uuid,bytea,bytea)', 'EXECUTE') AS hb_pipe,
                has_function_privilege('authenticated', 'home_place_label(uuid,bytea,bytea)', 'EXECUTE') AS hb_auth,
                has_function_privilege('pipeline', 'baby_has_quarantined_photos(uuid)', 'EXECUTE') AS q_pipe,
                has_function_privilege('service_role', 'baby_has_quarantined_photos(uuid)', 'EXECUTE') AS q_svc,
                has_function_privilege('authenticated', 'baby_has_quarantined_photos(uuid)', 'EXECUTE') AS q_auth`,
      );
      expect(r).toEqual({
        ft_auth: true,
        ft_viewer: false,
        ft_pipe: true,
        us_auth: true,
        us_viewer: false,
        h_pipe: true,
        h_auth: false,
        hb_pipe: true,
        hb_auth: false,
        q_pipe: true,
        q_svc: true,
        q_auth: false,
      });
    });
  });

  describe("session guard trigger (upload_files_session_owner)", () => {
    it("a member cannot register a file into someone else's session", async () => {
      // Admin A2 sees the contributor's session (so RLS passes) but is not its owner: the
      // trigger refuses regardless of the policy.
      await db.asUser(U.adminA2, async (c) => {
        const [sql, params] = fileSql(id(4, 90), S.contrib, BABY.A);
        const e = await tryQuery(c, sql as string, params as unknown[]);
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/belongs to another user/);
      });
    });

    it("a contributor cannot register into the admin's session (the trigger fires before RLS)", async () => {
      await db.asUser(U.contribA, async (c) => {
        const [sql, params] = fileSql(id(4, 91), S.admin, BABY.A);
        const e = await tryQuery(c, sql as string, params as unknown[]);
        expect(e?.message).toMatch(/belongs to another user/);
      });
    });

    it("a stranger cannot register into any session (trigger, even before RLS)", async () => {
      await db.asUser(U.stranger, async (c) => {
        const [sql, params] = fileSql(id(4, 92), S.contrib, BABY.A);
        const e = await tryQuery(c, sql as string, params as unknown[]);
        expect(e).not.toBeNull();
        expect(e?.message).toMatch(/belongs to another user/);
      });
    });

    it("the owner registers a file into an open session", async () => {
      await db.asUser(U.contribA, async (c) => {
        const [sql, params] = fileSql(id(4, 93), S.contrib, BABY.A);
        expect(await tryQuery(c, sql as string, params as unknown[])).toBeNull();
      });
    });

    it("expired and finished sessions are closed", async () => {
      await db.asUser(U.contribA, async (c) => {
        for (const sid of [S.expired, S.finished]) {
          const [sql, params] = fileSql(id(4, 94), sid, BABY.A);
          const e = await tryQuery(c, sql as string, params as unknown[]);
          expect(e?.code, sid).toBe("23514");
          expect(e?.message).toMatch(/upload session is closed/);
        }
      });
    });

    it("an unknown session is reported as closed (superuser too)", async () => {
      await sandbox(async () => {
        const [sql, params] = fileSql(id(4, 95), id(3, 99), BABY.A);
        const e = await err(sql as string, params as unknown[]);
        expect(e?.message).toMatch(/upload session is closed/);
      });
    });

    it("the 501st file is refused: 'upload session is full'", async () => {
      await db.asUser(U.contribA, async (c) => {
        const cnt = await c.query(
          "SELECT count(*)::int AS n FROM upload_files WHERE session_id = $1",
          [S.full],
        );
        expect(cnt.rows[0].n).toBe(MAX_FILES_PER_SESSION);
        const [sql, params] = fileSql(id(4, 96), S.full, BABY.A);
        const e = await tryQuery(c, sql as string, params as unknown[]);
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/upload session is full/);
      });
    });

    it("a single statement inserting 501 rows into an empty session fails on the 501st", async () => {
      await sandbox(async () => {
        const sid = id(3, 50);
        await q("INSERT INTO upload_sessions (id, baby_id, created_by) VALUES ($1, $2, $3)", [
          sid,
          BABY.A,
          U.adminA1,
        ]);
        const e = await err(
          `INSERT INTO upload_files (session_id, baby_id, declared_bytes, storage_key, part_size)
           SELECT $1, $2, 10, 'e-db/bulk/' || g, 8388608 FROM generate_series(1, 501) g`,
          [sid, BABY.A],
        );
        expect(e?.message).toMatch(/upload session is full/);
        // 500 in one statement is fine.
        expect(
          await err(
            `INSERT INTO upload_files (session_id, baby_id, declared_bytes, storage_key, part_size)
             SELECT $1, $2, 10, 'e-db/bulk500/' || g, 8388608 FROM generate_series(1, 500) g`,
            [sid, BABY.A],
          ),
        ).toBeNull();
      });
    });

    it("a file must belong to the baby of its session", async () => {
      await sandbox(async () => {
        const [sql, params] = fileSql(id(4, 97), S.admin, BABY.B);
        const e = await err(sql as string, params as unknown[]);
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/must belong to the baby of its session/);
      });
    });

    it("duplicate_of_photo_id must be a photo of the same baby (insert and update)", async () => {
      await sandbox(async () => {
        const bad = await err(
          `INSERT INTO upload_files (session_id, baby_id, declared_bytes, storage_key, part_size, duplicate_of_photo_id)
           VALUES ($1, $2, 10, $3, 8388608, $4)`,
          [S.admin, BABY.A, key(), P.b1],
        );
        expect(bad?.code).toBe("23514");
        expect(bad?.message).toMatch(/duplicate_of_photo_id must be a photo of the same baby/);
        const upd = await err("UPDATE upload_files SET duplicate_of_photo_id = $2 WHERE id = $1", [
          F.admin,
          P.b1,
        ]);
        expect(upd?.code).toBe("23514");
        expect(
          await err("UPDATE upload_files SET duplicate_of_photo_id = $2 WHERE id = $1", [
            F.admin,
            P.approved1,
          ]),
        ).toBeNull();
      });
    });

    it("photo_id must equal id (CHECK)", async () => {
      await sandbox(async () => {
        const e = await err("UPDATE upload_files SET photo_id = $2 WHERE id = $1", [
          F.admin,
          P.approved1,
        ]);
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/upload_files_photo_id_is_id/);
      });
    });

    it("the batch note/people stay out of the pipeline's reach; pipeline cannot INSERT/DELETE", async () => {
      await db.asPipeline(async (c) => {
        const ok = await tryQuery(
          c,
          "SELECT id, baby_id, finished_at, expires_at FROM upload_sessions",
        );
        expect(ok).toBeNull();
        for (const col of ["note", "people", "location_label", "milestone_id", "created_by"]) {
          const e = await tryQuery(c, `SELECT ${col} FROM upload_sessions`);
          expect(e?.message, col).toMatch(PERMISSION_DENIED);
        }
        expect((await tryQuery(c, "SELECT * FROM upload_sessions"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        const [sql, params] = fileSql(id(4, 98), S.admin, BABY.A);
        expect((await tryQuery(c, sql as string, params as unknown[]))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect((await tryQuery(c, "DELETE FROM upload_files"))?.message).toMatch(PERMISSION_DENIED);
        expect((await tryQuery(c, "DELETE FROM upload_sessions"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect(
          (
            await tryQuery(c, "INSERT INTO upload_sessions (baby_id, created_by) VALUES ($1, $2)", [
              BABY.A,
              U.adminA1,
            ])
          )?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("pipeline may update upload_files state/error but not storage_key", async () => {
      await db.asPipeline(async (c) => {
        expect(
          await tryQuery(
            c,
            "UPDATE upload_files SET state = 'ingested', error = NULL WHERE id = $1",
            [F.admin],
          ),
        ).toBeNull();
        const r = await c.query("SELECT state FROM upload_files WHERE id = $1", [F.admin]);
        expect(r.rows[0].state).toBe("ingested");
        const e = await tryQuery(c, "UPDATE upload_files SET storage_key = 'x' WHERE id = $1", [
          F.admin,
        ]);
        expect(e?.message).toMatch(PERMISSION_DENIED);
        const e2 = await tryQuery(c, "UPDATE upload_files SET declared_bytes = 1 WHERE id = $1", [
          F.admin,
        ]);
        expect(e2?.message).toMatch(PERMISSION_DENIED);
      });
    });

    it("authenticated cannot DELETE sessions or files, nor rewrite storage_key", async () => {
      await db.asUser(U.adminA1, async (c) => {
        expect((await tryQuery(c, "DELETE FROM upload_files"))?.message).toMatch(PERMISSION_DENIED);
        expect((await tryQuery(c, "DELETE FROM upload_sessions"))?.message).toMatch(
          PERMISSION_DENIED,
        );
        expect(
          (await tryQuery(c, "UPDATE upload_files SET storage_key = 'x' WHERE id = $1", [F.admin]))
            ?.message,
        ).toMatch(PERMISSION_DENIED);
      });
    });

    it("only the creator can finish a session", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const r = await c.query("UPDATE upload_sessions SET finished_at = now() WHERE id = $1", [
          S.contrib,
        ]);
        expect(r.rowCount).toBe(0); // visible to the admin, but not updatable
      });
      await db.asUser(U.contribA, async (c) => {
        const r = await c.query("UPDATE upload_sessions SET finished_at = now() WHERE id = $1", [
          S.contrib,
        ]);
        expect(r.rowCount).toBe(1);
      });
    });

    it("a member cannot create a session for someone else or for a baby they do not belong to", async () => {
      await db.asUser(U.contribA, async (c) => {
        const e = await tryQuery(
          c,
          "INSERT INTO upload_sessions (baby_id, created_by) VALUES ($1, $2)",
          [BABY.A, U.adminA1],
        );
        expect(e?.message).toMatch(/row-level security/i);
      });
      await db.asUser(U.stranger, async (c) => {
        const e = await tryQuery(
          c,
          "INSERT INTO upload_sessions (baby_id, created_by) VALUES ($1, $2)",
          [BABY.A, U.stranger],
        );
        expect(e?.message).toMatch(/row-level security/i);
      });
      await db.asUser(U.contribA, async (c) => {
        expect(
          await tryQuery(c, "INSERT INTO upload_sessions (baby_id, created_by) VALUES ($1, $2)", [
            BABY.A,
            U.contribA,
          ]),
        ).toBeNull();
      });
    });
  });

  describe("completion: INSERT INTO photos with id = upload_files.id", () => {
    it("an admin's completion row may be approved; a contributor's must be pending", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const e = await tryQuery(
          c,
          `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval, approved_by, approved_at)
           VALUES ($1, $2, $3, 'e-db/c1', 'approved', $3, now())`,
          [F.admin, BABY.A, U.adminA1],
        );
        expect(e).toBeNull();
      });
      await db.asUser(U.contribA, async (c) => {
        const approved = await tryQuery(
          c,
          `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval)
           VALUES ($1, $2, $3, 'e-db/c2', 'approved')`,
          [F.contrib, BABY.A, U.contribA],
        );
        expect(approved?.message).toMatch(/row-level security/i);
        const pending = await tryQuery(
          c,
          `INSERT INTO photos (id, baby_id, uploaded_by, storage_key_original, approval)
           VALUES ($1, $2, $3, 'e-db/c3', 'pending')`,
          [F.contrib, BABY.A, U.contribA],
        );
        expect(pending).toBeNull();
        // Can mark the file completed and point photo_id at itself.
        expect(
          await tryQuery(
            c,
            "UPDATE upload_files SET state = 'completed', photo_id = id WHERE id = $1",
            [F.contrib],
          ),
        ).toBeNull();
      });
    });

    it("a contributor cannot insert a photo as someone else, or into a baby they are not in", async () => {
      await db.asUser(U.contribA, async (c) => {
        const as = await tryQuery(
          c,
          `INSERT INTO photos (baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, 'e-db/x1', 'pending')`,
          [BABY.A, U.adminA1],
        );
        expect(as?.message).toMatch(/row-level security/i);
        const other = await tryQuery(
          c,
          `INSERT INTO photos (baby_id, uploaded_by, storage_key_original, approval) VALUES ($1, $2, 'e-db/x2', 'pending')`,
          [BABY.B, U.contribA],
        );
        expect(other?.message).toMatch(/row-level security/i);
      });
    });
  });

  describe("pipeline: photos columns, duplicate marker, purge", () => {
    it("status 'duplicate' is accepted and the pipeline can delete such a row (only that)", async () => {
      await sandbox(async () => {
        await insertPhoto(id(7, 1), BABY.A, { status: "uploaded" });
        await insertPhoto(id(7, 2), BABY.A, { status: "uploaded" });
        await q("SET LOCAL ROLE pipeline");
        expect(
          await err("UPDATE photos SET status = 'duplicate' WHERE id = $1", [id(7, 1)]),
        ).toBeNull();
        const del = await q("DELETE FROM photos WHERE id = $1", [id(7, 1)]);
        expect(del.rowCount).toBe(1);
        const live = await q("DELETE FROM photos WHERE id = $1", [id(7, 2)]);
        expect(live.rowCount).toBe(0); // a live photo is not deletable
        await q("RESET ROLE");
      });
    });

    it("the pipeline can set quarantined_at but not other photo columns (storage key, approval)", async () => {
      await db.asPipeline(async (c) => {
        expect(
          await tryQuery(c, "UPDATE photos SET quarantined_at = now() WHERE id = $1", [
            P.approved2,
          ]),
        ).toBeNull();
        for (const col of [
          "storage_key_original = 'x'",
          "approval = 'rejected'",
          "uploaded_by = NULL",
        ]) {
          const e = await tryQuery(c, `UPDATE photos SET ${col} WHERE id = $1`, [P.approved2]);
          expect(e?.message, col).toMatch(PERMISSION_DENIED);
        }
      });
    });

    it("trash older than 30 days is deletable, newer is not, quarantined never", async () => {
      await sandbox(async () => {
        await insertPhoto(id(7, 3), BABY.A, { deleted: "31 days" });
        await insertPhoto(id(7, 4), BABY.A, { deleted: "29 days" });
        await insertPhoto(id(7, 5), BABY.A, { deleted: "40 days", quarantined: true });
        await q("SET LOCAL ROLE pipeline");
        expect((await q("DELETE FROM photos WHERE id = $1", [id(7, 3)])).rowCount).toBe(1);
        expect((await q("DELETE FROM photos WHERE id = $1", [id(7, 4)])).rowCount).toBe(0);
        expect((await q("DELETE FROM photos WHERE id = $1", [id(7, 5)])).rowCount).toBe(0);
        await q("RESET ROLE");
      });
    });

    it("authenticated users can never set quarantined_at", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const e = await tryQuery(c, "UPDATE photos SET quarantined_at = NULL WHERE id = $1", [
          P.approved1,
        ]);
        expect(e?.message).toMatch(PERMISSION_DENIED);
      });
    });
  });

  describe("quarantine: invisible to users, visible to service_role", () => {
    it("admin, contributor, stranger and viewer cannot see the photo or any child row", async () => {
      const probes = [
        ["photos", "id"],
        ["photo_derivatives", "photo_id"],
        ["photo_exif", "photo_id"],
        ["photo_details", "photo_id"],
      ] as const;
      for (const user of [U.adminA1, U.adminA2, U.contribA]) {
        await db.asUser(user, async (c) => {
          for (const [t, col] of probes) {
            const r = await c.query(`SELECT 1 FROM ${t} WHERE ${col} = ANY($1::uuid[])`, [
              [QP, QP_OWN],
            ]);
            expect(r.rowCount, `${user} ${t}`).toBe(0);
          }
        });
      }
      await db.asViewer(LINK.LA, async (c) => {
        const r = await c.query("SELECT 1 FROM photos WHERE id = $1", [QP]);
        expect(r.rowCount).toBe(0);
        const d = await c.query("SELECT 1 FROM photo_derivatives WHERE photo_id = $1", [QP]);
        expect(d.rowCount).toBe(0);
      });
    });

    it("the uploader does not see their own quarantined upload either", async () => {
      await db.asUser(U.contribA, async (c) => {
        expect((await c.query("SELECT 1 FROM photos WHERE id = $1", [QP_OWN])).rowCount).toBe(0);
      });
    });

    it("it cannot be approved, trashed, edited or used as an avatar by a user", async () => {
      await db.asUser(U.adminA1, async (c) => {
        const upd = await c.query(
          "UPDATE photos SET deleted_at = now(), is_sensitive = true WHERE id = $1",
          [QP],
        );
        expect(upd.rowCount).toBe(0);
        // WHERE-less form: still no quarantined row touched.
        const all = await c.query(
          "UPDATE photos SET is_sensitive = is_sensitive WHERE quarantined_at IS NOT NULL",
        );
        expect(all.rowCount).toBe(0);
        const ed = await c.query("SELECT photo_editable($1) AS e", [QP]);
        expect(ed.rows[0].e).toBe(false);
        const av = await tryQuery(c, "UPDATE babies SET avatar_photo_id = $2 WHERE id = $1", [
          BABY.A,
          QP,
        ]);
        expect(av?.code).toBe("23514");
        expect(av?.message).toMatch(/avatar must be an approved/);
      });
      await db.asUser(U.contribA, async (c) => {
        expect((await c.query("SELECT photo_editable($1) AS e", [QP_OWN])).rows[0].e).toBe(false);
      });
    });

    it("service_role (BYPASSRLS) and the pipeline still see it", async () => {
      await db.asRole("service_role", null, async (c) => {
        const r = await c.query("SELECT id FROM photos WHERE id = ANY($1::uuid[])", [[QP, QP_OWN]]);
        expect(r.rowCount).toBe(2);
      });
      await db.asPipeline(async (c) => {
        const r = await c.query("SELECT id FROM photos WHERE id = ANY($1::uuid[])", [[QP, QP_OWN]]);
        expect(r.rowCount).toBe(2);
      });
    });
  });

  describe("home_place_label", () => {
    const label = async (
      c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
      baby: string,
      lat: number | null,
      lng: number | null,
    ) => {
      await c.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
      const r = await c.query("SELECT home_place_label($1::uuid, $2::float8, $3::float8) AS l", [
        baby,
        lat,
        lng,
      ]);
      return r.rows[0]?.l ?? null;
    };

    it("'Home' within 150 m of the encrypted home, NULL beyond", async () => {
      await db.asPipeline(async (c) => {
        expect(await label(c, HOME_BABY, 47.6062, -122.3321)).toBe("Home");
        // 0.001 deg lat = ~111 m.
        expect(await label(c, HOME_BABY, 47.6072, -122.3321)).toBe("Home");
        // 0.0015 deg lat = ~167 m.
        expect(await label(c, HOME_BABY, 47.6077, -122.3321)).toBeNull();
        // Far away.
        expect(await label(c, HOME_BABY, 40.0, -100.0)).toBeNull();
      });
    });

    it("NULL when the baby has no home, NULL input gives NULL (STRICT)", async () => {
      await db.asPipeline(async (c) => {
        expect(await label(c, NO_HOME_BABY, 47.6062, -122.3321)).toBeNull();
        expect(await label(c, HOME_BABY, null, null)).toBeNull();
        expect(await label(c, HOME_BABY, 47.6062, null)).toBeNull();
      });
    });

    it("fails without the data key, and the error never carries a coordinate", async () => {
      await db.asPipeline(async (c) => {
        const e = await tryQuery(
          c,
          `SELECT home_place_label('${HOME_BABY}'::uuid, 47.6062::float8, -122.3321::float8)`,
        );
        expect(e).not.toBeNull();
        expect(e?.message).not.toMatch(/47\.6|122\.3/);
      });
    });

    it("the bytea overload round-trips through encrypt_coord", async () => {
      await db.asPipeline(async (c) => {
        await c.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
        const near = await c.query(
          "SELECT home_place_label($1::uuid, encrypt_coord(47.6062), encrypt_coord(-122.3321)) AS l",
          [HOME_BABY],
        );
        expect(near.rows[0].l).toBe("Home");
        const far = await c.query(
          "SELECT home_place_label($1::uuid, encrypt_coord(10.0), encrypt_coord(10.0)) AS l",
          [HOME_BABY],
        );
        expect(far.rows[0].l).toBeNull();
      });
    });

    it("pipeline cannot read plain home coordinates through it beyond Home / NULL", async () => {
      await db.asPipeline(async (c) => {
        await c.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
        const r = await c.query(
          "SELECT pg_typeof(home_place_label($1::uuid, 1::float8, 1::float8))::text AS t",
          [HOME_BABY],
        );
        expect(r.rows[0].t).toBe("text");
      });
    });
  });

  describe("free-tier cap predicate", () => {
    it("free_tier_photo_count is exact for a contributor (pending counts; failed/duplicate/trashed/quarantined do not)", async () => {
      // Counted: ready + 2 pending = 3 (contribA cannot see the admin's pending one via RLS but the
      // SECURITY DEFINER helper still counts it).
      await db.asUser(U.contribA, async (c) => {
        const r = await c.query("SELECT free_tier_photo_count($1) AS n", [FREE_BABY]);
        expect(r.rows[0].n).toBe(3);
      });
      await db.asUser(U.adminA1, async (c) => {
        expect(
          (await c.query("SELECT free_tier_photo_count($1) AS n", [FREE_BABY])).rows[0].n,
        ).toBe(3);
      });
    });

    it("is 0 for a non-member, and the full count without claims", async () => {
      await db.asUser(U.stranger, async (c) => {
        expect(
          (await c.query("SELECT free_tier_photo_count($1) AS n", [FREE_BABY])).rows[0].n,
        ).toBe(0);
      });
      await db.asUser(U.adminB, async (c) => {
        expect(
          (await c.query("SELECT free_tier_photo_count($1) AS n", [FREE_BABY])).rows[0].n,
        ).toBe(0);
      });
      await db.asPipeline(async (c) => {
        expect(
          (await c.query("SELECT free_tier_photo_count($1) AS n", [FREE_BABY])).rows[0].n,
        ).toBe(3);
      });
    });

    it("the cap trigger uses the same predicate: 1000 counted rows block, failed/duplicate rows do not count", async () => {
      await sandbox(async () => {
        const cap = id(2, 9);
        await q(
          "INSERT INTO babies (id, name, birth_date, plan) VALUES ($1, 'Cap', '2026-01-01', 'free')",
          [cap],
        );
        await q(
          `INSERT INTO photos (baby_id, storage_key_original, status)
           SELECT $1, 'e-db/cap/' || g, 'failed' FROM generate_series(1, 20) g`,
          [cap],
        );
        await q(
          `INSERT INTO photos (baby_id, storage_key_original, status)
           SELECT $1, 'e-db/capd/' || g, 'duplicate' FROM generate_series(1, 20) g`,
          [cap],
        );
        await q(
          `INSERT INTO photos (baby_id, storage_key_original, status)
           SELECT $1, 'e-db/capok/' || g, 'ingested' FROM generate_series(1, ${FREE_TIER_PHOTO_LIMIT}) g`,
          [cap],
        );
        const full = await err(
          "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'e-db/cap/over')",
          [cap],
        );
        expect(full?.code).toBe("23514");
        expect(full?.message).toMatch(/free tier photo limit/);
        // Trashing one frees a slot; failing one frees a slot too.
        await q("UPDATE photos SET deleted_at = now() WHERE storage_key_original = 'e-db/capok/1'");
        expect(
          await err(
            "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'e-db/cap/s1')",
            [cap],
          ),
        ).toBeNull();
        expect(
          (
            await err(
              "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'e-db/cap/s2')",
              [cap],
            )
          )?.message,
        ).toMatch(/free tier photo limit/);
        await q("UPDATE photos SET status = 'failed' WHERE storage_key_original = 'e-db/capok/2'");
        expect(
          await err(
            "INSERT INTO photos (baby_id, storage_key_original) VALUES ($1, 'e-db/cap/s3')",
            [cap],
          ),
        ).toBeNull();
      });
    });
  });

  describe("baby purge guard", () => {
    it("pipeline cannot delete a trashed baby that holds a quarantined photo", async () => {
      await db.asPipeline(async (c) => {
        const r = await c.query("DELETE FROM babies WHERE id = $1", [QUAR_BABY]);
        expect(r.rowCount).toBe(0);
      });
      expect((await one("SELECT count(*)::int AS n FROM photos WHERE id = $1", [QP_BABY])).n).toBe(
        1,
      );
    });

    it("a trashed baby without a quarantined photo is deletable by the pipeline", async () => {
      await db.asPipeline(async (c) => {
        const r = await c.query("DELETE FROM babies WHERE id = $1", [CLEAN_OLD_BABY]);
        expect(r.rowCount).toBe(1);
      });
    });

    it("service_role is not blocked by the guard", async () => {
      await db.asRole("service_role", null, async (c) => {
        const r = await c.query("DELETE FROM babies WHERE id = $1", [QUAR_BABY]);
        expect(r.rowCount).toBe(1);
      });
    });

    it("baby_has_quarantined_photos reflects the data", async () => {
      expect(
        await one<{ a: boolean; b: boolean }>(
          "SELECT baby_has_quarantined_photos($1) AS a, baby_has_quarantined_photos($2) AS b",
          [QUAR_BABY, CLEAN_OLD_BABY],
        ),
      ).toEqual({ a: true, b: false });
    });
  });
});
