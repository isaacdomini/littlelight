import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BABY,
  createFixtures,
  dropFixtures,
  EMAIL,
  LINK,
  P,
  U,
  VIEWER_SESSION_A,
} from "./test/fixtures";
import {
  authed,
  connect,
  type Db,
  databaseUrl,
  ensureMigrated,
  tryQuery,
  viewerClaims,
} from "./test/harness";

// Step 8 database rules (docs/plans/step-8.md 2.3, 2.12; PRD FR-9.5 "sensitive photos never
// auto-share", FR-9.6 expiry and revoke, "Share-link viewers (no account)"). Everything runs on
// one superuser connection inside a transaction that is rolled back, switching role with
// `SET LOCAL ROLE` and JWT claims like the API does. The two-connection race tests commit and
// clean up after themselves.

describe.skipIf(!databaseUrl)("sharing (step 8 database rules)", () => {
  let db: Db;
  const a = () => db.admin;
  const q = (sql: string, params: unknown[] = []) => a().query(sql, params);
  const err = (sql: string, params: unknown[] = []) => tryQuery(a(), sql, params);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows[0] as T;

  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await a().query("BEGIN");
    try {
      return await fn();
    } finally {
      await a().query("ROLLBACK");
    }
  }
  async function as(role: string, claims: Record<string, unknown> | null = null) {
    await q("RESET ROLE");
    if (role !== "postgres") await q(`SET LOCAL ROLE ${role}`);
    await q("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims ?? {})]);
  }
  const admin1 = () => as("authenticated", authed(U.adminA1, EMAIL.adminA1));
  const contrib = () => as("authenticated", authed(U.contribA, EMAIL.contribA));
  const stranger = () => as("authenticated", authed(U.stranger, EMAIL.stranger));
  const viewerOf = (link: string) => as("viewer", viewerClaims(link));
  const su = () => as("postgres");

  const hashOf = () => `decode(md5('${randomUUID()}') || md5('x'), 'hex')`;
  const analyse = (photo: string) =>
    q(
      `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description)
       VALUES ($1, 'fake', 'v1', 'v1', '{"caption":"x"}'::jsonb) ON CONFLICT DO NOTHING`,
      [photo],
    );
  const shareRule = (link: string, photo: string) =>
    err("INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')", [
      link,
      photo,
    ]);
  const shareUser = (link: string, photo: string, released = false) =>
    err(
      `INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id, sensitive_released_at, sensitive_released_by)
       VALUES ($1, $2, 'user', $3, ${released ? "now()" : "NULL"}, ${released ? "$3::uuid" : "NULL"})`,
      [link, photo, U.adminA1],
    );
  const derivative = (photo: string, kind = "thumb") =>
    q(
      `INSERT INTO photo_derivatives (photo_id, kind, storage_key, width, height, bytes)
       VALUES ($1, $2, $3, 10, 10, 10) ON CONFLICT DO NOTHING`,
      [photo, kind, `babies/${BABY.A}/derivatives/${photo}/${kind}.jpg`],
    );

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

  // ---------------------------------------------------------------------------------------------
  describe("shared_photos_gate: sensitive photos never auto-share", () => {
    it("refuses a rule row for a sensitive, unanalysed, excluded, quarantined, pending and trashed photo", async () => {
      await sandbox(async () => {
        await analyse(P.sensitive);
        await analyse(P.pendingOther);
        await analyse(P.trashed);
        await analyse(P.contribApproved);
        const refusals: Array<[string, RegExp]> = [
          [P.sensitive, /never auto-shared/],
          [P.pendingOther, /approved, non-deleted/],
          [P.trashed, /approved, non-deleted/],
        ];
        for (const [photo, re] of refusals) {
          const e = await shareRule(LINK.LA, photo);
          expect(e?.code, photo).toBe("23514");
          expect(e?.message).toMatch(re);
        }
        // unanalysed (free-tier photos are never analysed)
        await q("DELETE FROM photo_ai WHERE photo_id = $1", [P.contribApproved]);
        const unanalysed = await shareRule(LINK.LA, P.contribApproved);
        expect(unanalysed?.message).toMatch(/only analysed photos/);
        // excluded by an admin
        await analyse(P.contribApproved);
        await q(
          "INSERT INTO shared_photo_exclusions (share_link_id, photo_id, excluded_by) VALUES ($1, $2, $3)",
          [LINK.LA, P.contribApproved, U.adminA1],
        );
        const excluded = await shareRule(LINK.LA, P.contribApproved);
        expect(excluded?.message).toMatch(/removed from this album by an admin/);
        await q("DELETE FROM shared_photo_exclusions WHERE photo_id = $1", [P.contribApproved]);
        // quarantined
        await q("UPDATE photos SET quarantined_at = now() WHERE id = $1", [P.contribApproved]);
        expect((await shareRule(LINK.LA, P.contribApproved))?.code).toBe("23514");
        expect((await shareUser(LINK.LA, P.contribApproved))?.code).toBe("23514"); // manual too
        await q("UPDATE photos SET quarantined_at = NULL WHERE id = $1", [P.contribApproved]);
        // and the same photo is fine once everything is in order
        expect(await shareRule(LINK.LA, P.contribApproved)).toBeNull();
      });
    });

    it("holds for the pipeline role too, which has no way around the gate", async () => {
      await sandbox(async () => {
        await analyse(P.sensitive);
        await as("pipeline");
        const e = await shareRule(LINK.LA, P.sensitive);
        expect(e?.code).toBe("23514");
        expect(e?.message).toMatch(/never auto-shared/);
        // not even by pretending to be a hand-picked row
        const forged = await err(
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'user')",
          [LINK.LA, P.sensitive],
        );
        expect(forged?.code).toBe("42501"); // pipeline may only write rule rows
      });
    });

    it("an admin may hand-share a sensitive photo (hidden by default); release needs the admin who did it", async () => {
      await sandbox(async () => {
        expect(await shareUser(LINK.LA, P.sensitive)).toBeNull();
        await su();
        await q("DELETE FROM shared_photos WHERE photo_id = $1", [P.sensitive]);
        expect(await shareUser(LINK.LA, P.sensitive, true)).toBeNull();
        // a rule row can never carry a release
        await q("DELETE FROM shared_photos WHERE photo_id = $1", [P.sensitive]);
        await analyse(P.contribApproved);
        const withRelease = await err(
          `INSERT INTO shared_photos (share_link_id, photo_id, added_by, sensitive_released_at, sensitive_released_by)
           VALUES ($1, $2, 'rule', now(), $3)`,
          [LINK.LA, P.contribApproved, U.adminA1],
        );
        expect(withRelease?.code).toBe("23514");
      });
    });

    it("a sensitive flag removes rule rows (not user rows), whichever way the flag arrives", async () => {
      await sandbox(async () => {
        await analyse(P.contribApproved);
        expect(await shareRule(LINK.LA, P.contribApproved)).toBeNull();
        expect(await shareUser(LINK.LAexpired, P.contribApproved)).toBeNull();
        await q("UPDATE photos SET is_sensitive = true WHERE id = $1", [P.contribApproved]);
        const rows = (
          await q("SELECT share_link_id, added_by FROM shared_photos WHERE photo_id = $1", [
            P.contribApproved,
          ])
        ).rows;
        expect(rows).toEqual([{ share_link_id: LINK.LAexpired, added_by: "user" }]);
        // and never again as a rule row
        expect((await shareRule(LINK.LA, P.contribApproved))?.message).toMatch(/never auto-shared/);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("race: a rule insert and a sensitive flag on two connections", () => {
    async function second() {
      const c = new pg.Client({ connectionString: databaseUrl });
      await c.connect();
      return c;
    }
    const cleanup = async (photo: string) => {
      await q("DELETE FROM shared_photos WHERE photo_id = $1 AND share_link_id = $2", [
        photo,
        LINK.LA,
      ]);
      await q("DELETE FROM photo_ai WHERE photo_id = $1", [photo]);
      await q("UPDATE photos SET is_sensitive = false WHERE id = $1", [photo]);
    };

    it("rule insert first (uncommitted), flag second: no rule row of a sensitive photo survives", async () => {
      const photo = P.contribApproved;
      await analyse(photo);
      const other = await second();
      try {
        await a().query("BEGIN");
        await shareRule(LINK.LA, photo);
        const flag = other.query("UPDATE photos SET is_sensitive = true WHERE id = $1", [photo]);
        await new Promise((r) => setTimeout(r, 300)); // the flag waits on the gate's FOR SHARE
        await a().query("COMMIT");
        await flag;
        const { rows } = await q(
          "SELECT count(*)::int n FROM shared_photos WHERE photo_id = $1 AND added_by = 'rule'",
          [photo],
        );
        expect(rows[0].n).toBe(0);
      } finally {
        await a()
          .query("ROLLBACK")
          .catch(() => undefined);
        await other.end();
        await cleanup(photo);
      }
    });

    it("flag first (uncommitted), rule insert second: the insert is refused", async () => {
      const photo = P.contribApproved;
      await analyse(photo);
      const other = await second();
      try {
        await other.query("BEGIN");
        await other.query("UPDATE photos SET is_sensitive = true WHERE id = $1", [photo]);
        const insert = a().query(
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')",
          [LINK.LA, photo],
        );
        const settled = insert.then(
          () => "inserted",
          (e: { code?: string }) => e.code ?? "error",
        );
        await new Promise((r) => setTimeout(r, 300));
        await other.query("COMMIT");
        expect(await settled).toBe("23514");
        const { rows } = await q(
          "SELECT count(*)::int n FROM shared_photos WHERE photo_id = $1 AND added_by = 'rule'",
          [photo],
        );
        expect(rows[0].n).toBe(0);
      } finally {
        await other.query("ROLLBACK").catch(() => undefined);
        await other.end();
        await cleanup(photo);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("viewer visibility", () => {
    it("a viewer sees the link's visible photos and media, nothing of another link or baby", async () => {
      await sandbox(async () => {
        await derivative(P.approved1, "thumb");
        await derivative(P.approved1, "display");
        await derivative(P.approved1, "analysis");
        await derivative(P.b1, "thumb");
        await viewerOf(LINK.LA);
        const photos = (await q("SELECT id FROM photos ORDER BY id")).rows.map((r) => r.id);
        expect(photos).toEqual([P.approved1, P.approved2].sort());
        const kinds = (
          await q("SELECT kind FROM photo_derivatives WHERE photo_id = $1 ORDER BY kind", [
            P.approved1,
          ])
        ).rows.map((r) => r.kind);
        expect(kinds).toEqual(["display", "thumb"]); // never `analysis`
        expect((await q("SELECT 1 FROM photos WHERE id = $1", [P.b1])).rowCount).toBe(0);
        expect(
          (await q("SELECT 1 FROM photo_derivatives WHERE photo_id = $1", [P.b1])).rowCount,
        ).toBe(0);
        expect(
          (await q("SELECT 1 FROM shared_photos WHERE share_link_id = $1", [LINK.LB])).rowCount,
        ).toBe(0);
        // a viewer of the other baby's link sees only that one
        await viewerOf(LINK.LB);
        expect((await q("SELECT id FROM photos")).rows.map((r) => r.id)).toEqual([P.b1]);
      });
    });

    it("a hand-shared sensitive photo is a listed row but its derivatives are unreadable until released", async () => {
      await sandbox(async () => {
        await derivative(P.sensitive, "thumb");
        await derivative(P.sensitive, "display");
        expect(await shareUser(LINK.LA, P.sensitive)).toBeNull();
        await viewerOf(LINK.LA);
        expect(
          (await q("SELECT 1 FROM shared_photos WHERE photo_id = $1", [P.sensitive])).rowCount,
        ).toBe(1);
        expect(
          (await q("SELECT 1 FROM photo_derivatives WHERE photo_id = $1", [P.sensitive])).rowCount,
        ).toBe(0);
        expect(
          (await q("SELECT public.viewer_can_see_media($1) AS ok", [P.sensitive])).rows[0].ok,
        ).toBe(false);
        // the admin releases it
        await su();
        await q(
          "UPDATE shared_photos SET sensitive_released_at = now(), sensitive_released_by = $3 WHERE share_link_id = $1 AND photo_id = $2",
          [LINK.LA, P.sensitive, U.adminA1],
        );
        await viewerOf(LINK.LA);
        expect(
          (await q("SELECT 1 FROM photo_derivatives WHERE photo_id = $1", [P.sensitive])).rowCount,
        ).toBe(2);
        expect(
          (await q("SELECT public.viewer_can_see_media($1) AS ok", [P.sensitive])).rows[0].ok,
        ).toBe(true);
        // a released one on ANOTHER link stays hidden there
        await su();
        await q(
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
          [LINK.LAexpired, P.sensitive, U.adminA1],
        );
        await viewerOf(LINK.LAexpired);
        expect((await q("SELECT 1 FROM photo_derivatives")).rowCount).toBe(0);
      });
    });

    it("an expired or revoked link shows nothing anywhere", async () => {
      await sandbox(async () => {
        await derivative(P.approved1, "thumb");
        for (const link of [LINK.LAexpired, LINK.LArevoked]) {
          await viewerOf(link);
          for (const t of [
            "photos",
            "shared_photos",
            "photo_derivatives",
            "share_links",
            "photo_details",
          ]) {
            expect(
              (await q(`SELECT 1 FROM ${t} LIMIT 1`).catch(() => ({ rowCount: 0 }))).rowCount,
              `${link} ${t}`,
            ).toBe(0);
          }
        }
      });
    });

    it("a viewer cannot read who added a photo, hashes, or the parent's other tables", async () => {
      await sandbox(async () => {
        await viewerOf(LINK.LA);
        for (const sql of [
          "SELECT added_by_user_id FROM shared_photos",
          "SELECT token_hash FROM share_links",
          "SELECT passcode_hash FROM share_links",
          "SELECT * FROM share_links",
          "SELECT * FROM viewer_sessions",
          "SELECT * FROM share_passcode_failures",
          "SELECT * FROM share_rules",
          "SELECT * FROM shared_photo_exclusions",
          "SELECT * FROM photo_exif",
          "SELECT * FROM photo_ai",
          "SELECT * FROM chat_messages",
          "SELECT * FROM audit_log",
        ]) {
          const e = await err(sql);
          expect(e?.code, sql).toBe("42501");
        }
        const w = await err("UPDATE share_links SET revoked_at = NULL");
        expect(w?.code).toBe("42501");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("sessions end by database rule", () => {
    const live = async () =>
      (
        await one<{ revoked: boolean }>(
          "SELECT revoked_at IS NOT NULL AS revoked FROM viewer_sessions WHERE id = $1",
          [VIEWER_SESSION_A],
        )
      ).revoked;

    it("a new token (regenerate), a new passcode and a revoke each end every open session; a rename does not", async () => {
      for (const [label, sql, ends] of [
        ["rename", "UPDATE share_links SET name = 'renamed' WHERE id = $1", false],
        [
          "expiry change",
          "UPDATE share_links SET expires_at = now() + interval '2 hours' WHERE id = $1",
          false,
        ],
        ["download toggle", "UPDATE share_links SET allow_download = true WHERE id = $1", false],
        ["token", `UPDATE share_links SET token_hash = ${hashOf()} WHERE id = $1`, true],
        ["passcode", "UPDATE share_links SET passcode_hash = 'scrypt$x' WHERE id = $1", true],
        ["revoke", "UPDATE share_links SET revoked_at = now() WHERE id = $1", true],
      ] as const) {
        await sandbox(async () => {
          expect(await live(), label).toBe(false);
          await q(sql, [LINK.LA]);
          expect(await live(), label).toBe(ends);
        });
      }
    });

    it("clearing the passcode does not end sessions; setting an identical hash again does not either", async () => {
      await sandbox(async () => {
        await q("UPDATE share_links SET passcode_hash = 'scrypt$x' WHERE id = $1", [LINK.LA]);
        await q("UPDATE viewer_sessions SET revoked_at = NULL WHERE id = $1", [VIEWER_SESSION_A]);
        await q("UPDATE share_links SET passcode_hash = 'scrypt$x' WHERE id = $1", [LINK.LA]);
        expect(await live()).toBe(false);
        await q("UPDATE share_links SET passcode_hash = NULL WHERE id = $1", [LINK.LA]);
        expect(await live()).toBe(false);
      });
    });

    it("a regenerate sets token_rotated_at; a session cannot be created on a dead link", async () => {
      await sandbox(async () => {
        await q(`UPDATE share_links SET token_hash = ${hashOf()} WHERE id = $1`, [LINK.LA]);
        expect(
          (
            await one<{ t: Date | null }>(
              "SELECT token_rotated_at t FROM share_links WHERE id = $1",
              [LINK.LA],
            )
          ).t,
        ).not.toBeNull();
      });
      await sandbox(async () => {
        for (const link of [LINK.LAexpired, LINK.LArevoked]) {
          const e = await err(
            "INSERT INTO viewer_sessions (share_link_id, expires_at) VALUES ($1, now() + interval '1 hour')",
            [link],
          );
          expect(e?.code, link).toBe("23514");
          expect(e?.message).toMatch(/share link is not active/);
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("viewer_session_check", () => {
    const check = async (jti: string) =>
      (await q("SELECT * FROM viewer_session_check($1)", [jti])).rows;
    const visits = async () =>
      (
        await one<{ view_count: number }>("SELECT view_count FROM share_links WHERE id = $1", [
          LINK.LA,
        ])
      ).view_count;

    it("answers one row for a live session with the link facts", async () => {
      await sandbox(async () => {
        await viewerOf(LINK.LA);
        const rows = await check(VIEWER_SESSION_A);
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]).sort()).toEqual(
          [
            "allow_download",
            "baby_id",
            "baby_name",
            "baby_nickname",
            "expires_at",
            "link_name",
            "share_link_id",
          ].sort(),
        );
        expect(rows[0]).toMatchObject({
          share_link_id: LINK.LA,
          baby_id: BABY.A,
          allow_download: false,
        });
      });
    });

    it("nothing for a revoked session, another link's jti, a random jti, no claims or a non-viewer role", async () => {
      await sandbox(async () => {
        await viewerOf(LINK.LB);
        expect(await check(VIEWER_SESSION_A)).toEqual([]); // LA's session with LB's claims
        await viewerOf(LINK.LA);
        expect(await check(randomUUID())).toEqual([]);
        await su();
        await q("UPDATE viewer_sessions SET revoked_at = now() WHERE id = $1", [VIEWER_SESSION_A]);
        await viewerOf(LINK.LA);
        expect(await check(VIEWER_SESSION_A)).toEqual([]);
        await as("viewer", {});
        expect(await check(VIEWER_SESSION_A)).toEqual([]);
        await admin1();
        const denied = await err("SELECT * FROM viewer_session_check($1)", [VIEWER_SESSION_A]);
        expect(denied?.code).toBe("42501");
      });
    });

    it("nothing once the link is revoked, expired or its baby is trashed", async () => {
      for (const sql of [
        "UPDATE share_links SET revoked_at = now() WHERE id = $1",
        "UPDATE share_links SET expires_at = now() - interval '1 second' WHERE id = $1",
      ]) {
        await sandbox(async () => {
          await q("UPDATE viewer_sessions SET revoked_at = NULL WHERE id = $1", [VIEWER_SESSION_A]);
          await q(sql, [LINK.LA]);
          await q("UPDATE viewer_sessions SET revoked_at = NULL WHERE id = $1", [VIEWER_SESSION_A]);
          await viewerOf(LINK.LA);
          expect(await check(VIEWER_SESSION_A), sql).toEqual([]);
        });
      }
      await sandbox(async () => {
        await q("UPDATE babies SET deleted_at = now() WHERE id = $1", [BABY.A]);
        await viewerOf(LINK.LA);
        expect(await check(VIEWER_SESSION_A)).toEqual([]);
      });
    });

    it("counts one visit per 30 minute gap and extends the session after a renew", async () => {
      await sandbox(async () => {
        const before = await visits();
        await viewerOf(LINK.LA);
        await check(VIEWER_SESSION_A);
        await check(VIEWER_SESSION_A);
        await su();
        expect(await visits()).toBe(before + 1);
        await q(
          "UPDATE viewer_sessions SET last_seen_at = now() - interval '29 minutes' WHERE id = $1",
          [VIEWER_SESSION_A],
        );
        await viewerOf(LINK.LA);
        await check(VIEWER_SESSION_A);
        await su();
        expect(await visits()).toBe(before + 1);
        await q(
          "UPDATE viewer_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1",
          [VIEWER_SESSION_A],
        );
        await viewerOf(LINK.LA);
        await check(VIEWER_SESSION_A);
        await su();
        expect(await visits()).toBe(before + 2);

        // renew: the link outlives the session; the check pulls the session's expiry forward
        await q("UPDATE share_links SET expires_at = now() + interval '24 hours' WHERE id = $1", [
          LINK.LA,
        ]);
        await viewerOf(LINK.LA);
        const [row] = await check(VIEWER_SESSION_A);
        await su();
        const s = await one<{ expires_at: Date }>(
          "SELECT expires_at FROM viewer_sessions WHERE id = $1",
          [VIEWER_SESSION_A],
        );
        expect(s.expires_at.getTime()).toBe((row as { expires_at: Date }).expires_at.getTime());
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("share_rules_shape", () => {
    it("a free baby cannot create or change a rule; deleting is always allowed", async () => {
      await sandbox(async () => {
        await q("UPDATE babies SET plan = 'plus' WHERE id = $1", [BABY.A]);
        await q(
          "INSERT INTO share_rules (share_link_id, mode) VALUES ($1, 'all') ON CONFLICT DO NOTHING",
          [LINK.LAexpired],
        );
        await q("UPDATE babies SET plan = 'free' WHERE id = $1", [BABY.A]);
        const ins = await err(
          "INSERT INTO share_rules (share_link_id, mode) VALUES ($1, 'milestones')",
          [LINK.LArevoked],
        );
        expect(ins?.message).toMatch(/need the paid plan/);
        const upd = await err(
          "UPDATE share_rules SET mode = 'milestones' WHERE share_link_id = $1",
          [LINK.LAexpired],
        );
        expect(upd?.message).toMatch(/need the paid plan/);
        expect(
          await err("DELETE FROM share_rules WHERE share_link_id = $1", [LINK.LAexpired]),
        ).toBeNull();
      });
    });

    it("validates tags: include tag required for `tags`, at most 20, 1 to 60 chars, normalized", async () => {
      await sandbox(async () => {
        await q("UPDATE babies SET plan = 'plus' WHERE id = $1", [BABY.A]);
        await q("DELETE FROM share_rules WHERE share_link_id = $1", [LINK.LA]);
        const ins = (mode: string, inc: string[], exc: string[] = []) =>
          err(
            "INSERT INTO share_rules (share_link_id, mode, include_tags, exclude_tags) VALUES ($1, $2, $3::text[], $4::text[])",
            [LINK.LA, mode, inc, exc],
          );
        expect((await ins("tags", []))?.message).toMatch(/at least one include tag/);
        expect(
          (
            await ins(
              "all",
              Array.from({ length: 21 }, (_, i) => `t${i}`),
            )
          )?.message,
        ).toMatch(/at most 20/);
        expect(
          (
            await ins(
              "all",
              [],
              Array.from({ length: 21 }, (_, i) => `t${i}`),
            )
          )?.message,
        ).toMatch(/at most 20/);
        expect((await ins("all", ["x".repeat(61)]))?.message).toMatch(/1 to 60/);
        expect((await ins("all", [""]))?.message).toMatch(/1 to 60/);
        expect((await ins("all", ["Upper"]))?.message).toMatch(/lower-case/);
        expect((await ins("all", [" padded "]))?.message).toMatch(/trimmed/);
        expect(await ins("tags", ["outdoor"], ["bath"])).toBeNull();
      });
    });

    it("a contributor and a stranger cannot read or write rules; an admin of another baby neither", async () => {
      await sandbox(async () => {
        await q("UPDATE babies SET plan = 'plus' WHERE id = $1", [BABY.A]);
        await q(
          "INSERT INTO share_rules (share_link_id, mode) VALUES ($1, 'all') ON CONFLICT DO NOTHING",
          [LINK.LA],
        );
        for (const who of [contrib, stranger]) {
          await who();
          expect((await q("SELECT 1 FROM share_rules")).rowCount).toBe(0);
          expect(
            (
              await err("INSERT INTO share_rules (share_link_id, mode) VALUES ($1, 'all')", [
                LINK.LAexpired,
              ])
            )?.code,
          ).toBe("42501");
        }
        await as("authenticated", authed(U.adminB));
        expect(
          (await q("SELECT 1 FROM share_rules WHERE share_link_id = $1", [LINK.LA])).rowCount,
        ).toBe(0);
        await admin1();
        expect(
          (await q("SELECT 1 FROM share_rules WHERE share_link_id = $1", [LINK.LA])).rowCount,
        ).toBe(1);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("share_links shape and cap", () => {
    it("refuses an expiry beyond 30 days, a bad passcode hash format and a ttl outside 1..720", async () => {
      await sandbox(async () => {
        const ins = (extra: { expires?: string; passcode?: string | null; ttl?: number }) =>
          err(
            `INSERT INTO share_links (baby_id, name, token_hash, passcode_hash, expires_at, ttl_hours, created_by)
             VALUES ($1, 'n', ${hashOf()}, $2, ${extra.expires ?? "now() + interval '24 hours'"}, $3, $4)`,
            [BABY.B, extra.passcode ?? null, extra.ttl ?? 24, U.adminB],
          );
        expect((await ins({ expires: "now() + interval '722 hours'" }))?.message).toMatch(
          /within 30 days/,
        );
        expect((await ins({ passcode: "123456" }))?.message).toMatch(/unknown format/);
        expect((await ins({ passcode: "hunter2" }))?.message).toMatch(/unknown format/);
        expect((await ins({ ttl: 0 }))?.message).toMatch(/1 to 720/);
        expect((await ins({ ttl: 721 }))?.message).toMatch(/1 to 720/);
        expect(
          await ins({
            passcode: "scrypt$1$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaA",
            expires: "now() + interval '720 hours'",
            ttl: 720,
          }),
        ).toBeNull();
      });
    });

    it("the 21st link of a baby is refused", async () => {
      await sandbox(async () => {
        const { n } = await one<{ n: number }>(
          "SELECT count(*)::int n FROM share_links WHERE baby_id = $1",
          [BABY.B],
        );
        for (let i = n; i < 20; i++) {
          await q(
            `INSERT INTO share_links (baby_id, name, token_hash, expires_at, created_by) VALUES ($1, 'n', ${hashOf()}, now() + interval '1 hour', $2)`,
            [BABY.B, U.adminB],
          );
        }
        const e = await err(
          `INSERT INTO share_links (baby_id, name, token_hash, expires_at, created_by) VALUES ($1, 'n', ${hashOf()}, now() + interval '1 hour', $2)`,
          [BABY.B, U.adminB],
        );
        expect(e?.message).toMatch(/share link limit reached/);
      });
    });

    it("an admin cannot read the hash columns but can write them; a contributor sees no links at all", async () => {
      await sandbox(async () => {
        await admin1();
        expect((await err("SELECT token_hash FROM share_links"))?.code).toBe("42501");
        expect((await err("SELECT passcode_hash FROM share_links"))?.code).toBe("42501");
        expect(
          (await q("SELECT id, has_passcode, ttl_hours FROM share_links")).rowCount,
        ).toBeGreaterThan(0);
        expect(
          await err(`UPDATE share_links SET passcode_hash = 'scrypt$x' WHERE id = $1`, [LINK.LA]),
        ).toBeNull();
        expect(
          (await q("SELECT has_passcode FROM share_links WHERE id = $1", [LINK.LA])).rows[0]
            .has_passcode,
        ).toBe(true);
        await contrib();
        expect((await q("SELECT 1 FROM share_links")).rowCount).toBe(0);
        await stranger();
        expect((await q("SELECT 1 FROM share_links")).rowCount).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("shared_photo_exclusions", () => {
    it("admins manage them; contributors and strangers see nothing and cannot insert; cross-baby photos are refused", async () => {
      await sandbox(async () => {
        await admin1();
        expect(
          await err(
            "INSERT INTO shared_photo_exclusions (share_link_id, photo_id, excluded_by) VALUES ($1, $2, $3)",
            [LINK.LA, P.approved1, U.adminA1],
          ),
        ).toBeNull();
        expect((await q("SELECT 1 FROM shared_photo_exclusions")).rowCount).toBe(1);
        // excluded_by must be the caller
        expect(
          (
            await err(
              "INSERT INTO shared_photo_exclusions (share_link_id, photo_id, excluded_by) VALUES ($1, $2, $3)",
              [LINK.LA, P.approved2, U.adminA2],
            )
          )?.code,
        ).toBe("42501");
        // a photo of another baby
        const cross = await err(
          "INSERT INTO shared_photo_exclusions (share_link_id, photo_id, excluded_by) VALUES ($1, $2, $3)",
          [LINK.LA, P.b1, U.adminA1],
        );
        expect(cross?.code).toBe("23514");
        for (const who of [contrib, stranger]) {
          await who();
          expect((await q("SELECT 1 FROM shared_photo_exclusions")).rowCount).toBe(0);
          expect(
            (
              await err(
                "INSERT INTO shared_photo_exclusions (share_link_id, photo_id, excluded_by) VALUES ($1, $2, $3)",
                [LINK.LA, P.approved2, U.contribA],
              )
            )?.code,
          ).toBe("42501");
        }
        await viewerOf(LINK.LA);
        expect((await err("SELECT 1 FROM shared_photo_exclusions"))?.code).toBe("42501");
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("share_passcode_failures", () => {
    const failure = (link: string) =>
      err(
        "INSERT INTO share_passcode_failures (share_link_id, ip_hash) VALUES ($1, decode(repeat('ab', 32), 'hex'))",
        [link],
      );

    it("is unreachable below service_role", async () => {
      await sandbox(async () => {
        for (const as_ of [
          admin1,
          contrib,
          stranger,
          () => viewerOf(LINK.LA),
          () => as("pipeline"),
        ]) {
          await as_();
          expect((await failure(LINK.LA))?.code).toBe("42501");
          expect((await err("SELECT 1 FROM share_passcode_failures"))?.code).toBe("42501");
        }
        await as("service_role");
        expect(await failure(LINK.LA)).toBeNull();
        expect((await q("SELECT 1 FROM share_passcode_failures")).rowCount).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    it("an ip hash must be 32 bytes", async () => {
      await sandbox(async () => {
        await as("service_role");
        const e = await err(
          "INSERT INTO share_passcode_failures (share_link_id, ip_hash) VALUES ($1, decode('abcd', 'hex'))",
          [LINK.LA],
        );
        expect(e?.code).toBe("23514");
      });
    });

    it("share_link_passcode_locked is true for the link's admin at 20 recent failures, false for others and after regenerate", async () => {
      await sandbox(async () => {
        await as("service_role");
        for (let i = 0; i < 20; i++) await failure(LINK.LA);
        const locked = async (link = LINK.LA) =>
          (await q("SELECT share_link_passcode_locked($1) AS l", [link])).rows[0].l;
        expect(await locked()).toBe(true);
        expect(await locked(LINK.LAexpired)).toBe(false);
        await admin1();
        expect(await locked()).toBe(true);
        await contrib();
        expect(await locked()).toBe(false);
        await stranger();
        expect(await locked()).toBe(false);
        await as("authenticated", authed(U.adminB));
        expect(await locked()).toBe(false);
        // regenerate: failures before token_rotated_at no longer count
        await su();
        await q(`UPDATE share_links SET token_hash = ${hashOf()} WHERE id = $1`, [LINK.LA]);
        await admin1();
        expect(await locked()).toBe(false);
        // lock state function: counts per ip and per link after rotation
        // (the transaction clock is frozen, so a failure "after" the rotation is stamped later)
        await as("service_role");
        await q(
          "INSERT INTO share_passcode_failures (share_link_id, ip_hash, created_at) VALUES ($1, decode(repeat('ab', 32), 'hex'), now() + interval '1 second')",
          [LINK.LA],
        );
        const st = (
          await q("SELECT * FROM share_passcode_lock_state($1, decode(repeat('ab', 32), 'hex'))", [
            LINK.LA,
          ])
        ).rows[0];
        expect(st).toMatchObject({
          ip_failures: 1,
          link_failures: 1,
          ip_retry_at: null,
          link_retry_at: null,
        });
      });
    });

    it("19 failures do not lock; the 5th failure of one ip reports when its window lifts", async () => {
      await sandbox(async () => {
        await as("service_role");
        for (let i = 0; i < 5; i++) await failure(LINK.LA);
        const st = (
          await q("SELECT * FROM share_passcode_lock_state($1, decode(repeat('ab', 32), 'hex'))", [
            LINK.LA,
          ])
        ).rows[0];
        expect(st.ip_failures).toBe(5);
        expect(st.ip_retry_at).not.toBeNull();
        expect(st.link_retry_at).toBeNull();
        expect((await q("SELECT share_link_passcode_locked($1) AS l", [LINK.LA])).rows[0].l).toBe(
          false,
        );
      });
    });
  });
});
