import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap } from "./src/index";
import { BABY, createFixtures, dropFixtures, EMAIL, LINK, P, U } from "./test/fixtures";
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
  viewerClaims,
} from "./test/harness";

// Review-fix regression tests for the step 2 migrations: viewer sensitive gate, invite
// consumption, GPS-key detection, column/function grants on coordinates, trigger-function
// EXECUTE grants and bootstrap error redaction. Everything runs on the superuser connection in a
// transaction that is rolled back; `as()` switches the effective role (and JWT claims) inside it,
// exactly like `SET LOCAL ROLE` + `request.jwt.claims` in the API.

describe.skipIf(!databaseUrl)("step 2 review-fix hardening", () => {
  let db: Db;
  const a = () => db.admin;
  const q = (sql: string, params: unknown[] = []) => a().query(sql, params);

  async function sandbox<T>(fn: () => Promise<T>): Promise<T> {
    await a().query("BEGIN");
    try {
      return await fn();
    } finally {
      await a().query("ROLLBACK");
    }
  }
  /** Become `role` with `claims` for the rest of the transaction (or until the next `as`). */
  async function as(role: string, claims: Record<string, unknown> | null = null) {
    await q("RESET ROLE");
    await q(`SET LOCAL ROLE ${role}`);
    await q("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims ?? {})]);
  }
  const admin1 = () => as("authenticated", authed(U.adminA1, EMAIL.adminA1));
  const viewerLA = () => as("viewer", viewerClaims(LINK.LA));
  const su = () => q("RESET ROLE");

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

  // -----------------------------------------------------------------------------------------------
  describe("viewer sensitive gate (FR-9.5)", () => {
    const shareByRule = (photo: string) =>
      q("INSERT INTO shared_photos (share_link_id, photo_id, added_by) VALUES ($1, $2, 'rule')", [
        LINK.LA,
        photo,
      ]);
    const viewerRows = async (photo: string) =>
      (await q("SELECT id FROM photos WHERE id = $1", [photo])).rowCount;
    const ruleRows = async (photo: string) => {
      await su();
      const r = await q(
        "SELECT count(*)::int AS n FROM shared_photos WHERE photo_id = $1 AND share_link_id = $2 AND added_by = 'rule'",
        [photo, LINK.LA],
      );
      return (r.rows[0] as { n: number }).n;
    };

    it("admin flags a rule-shared photo sensitive: viewer sees 0 rows and the rule row is deleted", async () => {
      await sandbox(async () => {
        await shareByRule(P.contribApproved);
        await viewerLA();
        expect(await viewerRows(P.contribApproved)).toBe(1);

        await admin1();
        const upd = await q("UPDATE photos SET is_sensitive = true WHERE id = $1", [
          P.contribApproved,
        ]);
        expect(upd.rowCount).toBe(1);

        await viewerLA();
        expect(await viewerRows(P.contribApproved)).toBe(0);
        expect(await ruleRows(P.contribApproved)).toBe(0);
      });
    });

    it("pipeline writing photo_ai sensitive_flags has the same effect", async () => {
      await sandbox(async () => {
        await shareByRule(P.contribApproved);
        await viewerLA();
        expect(await viewerRows(P.contribApproved)).toBe(1);

        await as("pipeline");
        await q(
          `INSERT INTO photo_ai (photo_id, model, prompt_version, schema_version, description, sensitive_flags)
           VALUES ($1, 'gpt-6-luna', 'v1', 'v1', '{"caption":"x"}'::jsonb, '{bath}')`,
          [P.contribApproved],
        );

        await viewerLA();
        expect(await viewerRows(P.contribApproved)).toBe(0);
        expect(await ruleRows(P.contribApproved)).toBe(0);
        await su();
        const p = await q("SELECT is_sensitive FROM photos WHERE id = $1", [P.contribApproved]);
        expect(p.rows[0]).toEqual({ is_sensitive: true });
      });
    });

    it("a user-added sensitive photo stays visible to the viewer, flagged is_sensitive", async () => {
      await sandbox(async () => {
        await q(
          "INSERT INTO shared_photos (share_link_id, photo_id, added_by, added_by_user_id) VALUES ($1, $2, 'user', $3)",
          [LINK.LA, P.sensitive, U.adminA1],
        );
        await viewerLA();
        const r = await q("SELECT id, is_sensitive FROM photos WHERE id = $1", [P.sensitive]);
        expect(r.rows).toEqual([{ id: P.sensitive, is_sensitive: true }]);
      });
    });

    it("flagging a user-shared photo sensitive later keeps the manual share (admin consent)", async () => {
      await sandbox(async () => {
        await admin1();
        await q("UPDATE photos SET is_sensitive = true WHERE id = $1", [P.approved1]);
        await viewerLA();
        const r = await q("SELECT is_sensitive FROM photos WHERE id = $1", [P.approved1]);
        expect(r.rows).toEqual([{ is_sensitive: true }]);
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("invite consumption (baby_members_consume_invite)", () => {
    const mkInvite = (email: string = EMAIL.stranger) =>
      q(
        `INSERT INTO invites (baby_id, email, role, token_hash, invited_by)
         VALUES ($1, $2, 'contributor', gen_random_bytes(32), $3)`,
        [BABY.A, email, U.adminA1],
      );
    const invite = async (email: string = EMAIL.stranger) => {
      await su();
      const r = await q(
        "SELECT accepted_at, accepted_by FROM invites WHERE baby_id = $1 AND email = $2",
        [BABY.A, email],
      );
      return r.rows[0] as { accepted_at: Date | null; accepted_by: string | null };
    };
    const strangerClaims = () => authed(U.stranger, EMAIL.stranger);
    const selfJoin = () =>
      tryQuery(
        a(),
        "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
        [BABY.A, U.stranger],
      );

    it("self-join sets accepted_at / accepted_by", async () => {
      await sandbox(async () => {
        await mkInvite();
        expect((await invite()).accepted_at).toBeNull();
        await as("authenticated", strangerClaims());
        expect(await selfJoin()).toBeNull();
        const inv = await invite();
        expect(inv.accepted_at).not.toBeNull();
        expect(inv.accepted_by).toBe(U.stranger);
      });
    });

    it("after an admin removes the member, rejoining on the used invite fails (RLS violation)", async () => {
      await sandbox(async () => {
        await mkInvite();
        await as("authenticated", strangerClaims());
        expect(await selfJoin()).toBeNull();

        await admin1();
        const del = await q("DELETE FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.stranger,
        ]);
        expect(del.rowCount).toBe(1);

        await as("authenticated", strangerClaims());
        const err = await selfJoin();
        expect(err?.code).toBe("42501");
        expect(err?.message).toMatch(RLS_VIOLATION);
      });
    });

    it("an admin direct-add marks the member's live invite accepted", async () => {
      await sandbox(async () => {
        await mkInvite();
        await admin1();
        await q(
          "INSERT INTO baby_members (baby_id, user_id, role, invited_by) VALUES ($1, $2, 'contributor', $3)",
          [BABY.A, U.stranger, U.adminA1],
        );
        const inv = await invite();
        expect(inv.accepted_at).not.toBeNull();
        expect(inv.accepted_by).toBe(U.stranger);
      });
    });

    it("direct-add by an admin with no invite at all is unaffected", async () => {
      await sandbox(async () => {
        await admin1();
        await q(
          "INSERT INTO baby_members (baby_id, user_id, role, invited_by) VALUES ($1, $2, 'contributor', $3)",
          [BABY.A, U.stranger, U.adminA1],
        );
        await su();
        const r = await q("SELECT role FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          BABY.A,
          U.stranger,
        ]);
        expect(r.rows).toEqual([{ role: "contributor" }]);
      });
    });

    it("creator INSERT INTO babies ... RETURNING still works and makes the creator admin", async () => {
      await sandbox(async () => {
        await as("authenticated", strangerClaims());
        const r = await q(
          "INSERT INTO babies (name, birth_date, created_by) VALUES ('New baby', '2026-01-01', $1) RETURNING id",
          [U.stranger],
        );
        expect(r.rowCount).toBe(1);
        const id = (r.rows[0] as { id: string }).id;
        const m = await q("SELECT role FROM baby_members WHERE baby_id = $1 AND user_id = $2", [
          id,
          U.stranger,
        ]);
        expect(m.rows).toEqual([{ role: "admin" }]);
      });
    });

    it("service_role insert without any invite is unaffected", async () => {
      await sandbox(async () => {
        await as("service_role");
        const err = await tryQuery(
          a(),
          "INSERT INTO baby_members (baby_id, user_id, role) VALUES ($1, $2, 'contributor')",
          [BABY.A, U.stranger],
        );
        expect(err).toBeNull();
      });
    });

    it("an expired or revoked invite does not let a self-join through", async () => {
      await sandbox(async () => {
        await mkInvite();
        await q("UPDATE invites SET revoked_at = now() WHERE baby_id = $1 AND email = $2", [
          BABY.A,
          EMAIL.stranger,
        ]);
        await as("authenticated", strangerClaims());
        const err = await selfJoin();
        expect(err?.message).toMatch(RLS_VIOLATION);
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("jsonb_has_gps_keys and photo_exif.raw_json", () => {
    const has = async (doc: unknown) =>
      (
        (await q("SELECT public.jsonb_has_gps_keys($1::jsonb) AS v", [JSON.stringify(doc)]))
          .rows[0] as { v: boolean }
      ).v;

    it.each([
      ["nested object", { a: { b: { GPSLatitude: 1 } } }],
      ["array of objects", { items: [{ ok: 1 }, { deeper: [{ GPSLongitude: 2 }] }] }],
      ["GeoTag", { GeoTag: "x" }],
      ["geo_location", { geo_location: "x" }],
      ["nested Latitude", { Exif: { Composite: { Latitude: 47.6 } } }],
      ["exact lat / lng / lon", { lat: 1 }],
      ["exact lng", { x: { lng: 1 } }],
      ["exact lon", { lon: 1 }],
    ])("true for %s", async (_name, doc) => {
      expect(await has(doc)).toBe(true);
    });

    it.each([
      ["ImageOrientation", { ImageOrientation: "Normal" }],
      ["Platform", { Platform: "ios", Make: "Acme" }],
      ["scalar number", 42],
      ["scalar string", "GPSLatitude"],
      ["array of scalars", ["gps", "lat"]],
      ["empty object", {}],
      ["null", null],
      ["values that look like coordinates but keys do not", { note: "latitude 47.6" }],
    ])("false for %s", async (_name, doc) => {
      expect(await has(doc)).toBe(false);
    });

    const bad = { Exif: { Composite: { Latitude: 47.60621 } }, other: [{ gpsX: -122.33212 }] };

    async function pgError(sql: string, params: unknown[]) {
      await q("SAVEPOINT e");
      try {
        await q(sql, params);
      } catch (e) {
        await q("ROLLBACK TO SAVEPOINT e");
        return e as pg.DatabaseError;
      }
      throw new Error("expected the statement to fail");
    }
    function expectNoLeak(e: pg.DatabaseError) {
      expect(e.code).toBe("23514");
      expect(e.message).toBe("photo_exif.raw_json must not carry coordinate keys");
      const text = [e.message, e.detail, e.hint, e.where, e.constraint, e.column].join("\n");
      for (const leak of ["47.6", "122.33", "Latitude", "gpsX", "Composite", 'raw_json":']) {
        expect(text).not.toContain(leak);
      }
    }

    it("INSERT with a nested coordinate key is rejected with 23514 and no row contents", async () => {
      await sandbox(async () => {
        const e = await pgError("INSERT INTO photo_exif (photo_id, raw_json) VALUES ($1, $2)", [
          P.approved2,
          JSON.stringify(bad),
        ]);
        expectNoLeak(e);
      });
    });

    it("UPDATE of raw_json to a nested coordinate key is rejected the same way", async () => {
      await sandbox(async () => {
        await q('INSERT INTO photo_exif (photo_id, raw_json) VALUES ($1, \'{"Make":"Acme"}\')', [
          P.approved2,
        ]);
        const e = await pgError("UPDATE photo_exif SET raw_json = $2 WHERE photo_id = $1", [
          P.approved2,
          JSON.stringify(bad),
        ]);
        expectNoLeak(e);
      });
    });

    it("pipeline (no EXECUTE on jsonb_has_gps_keys needed) is checked too, and clean JSON passes", async () => {
      await sandbox(async () => {
        await as("pipeline");
        const ok = await tryQuery(
          a(),
          'INSERT INTO photo_exif (photo_id, raw_json) VALUES ($1, \'{"ImageOrientation":"Normal"}\')',
          [P.approved2],
        );
        expect(ok).toBeNull();
        const err = await tryQuery(a(), "UPDATE photo_exif SET raw_json = $2 WHERE photo_id = $1", [
          P.approved2,
          JSON.stringify(bad),
        ]);
        expect(err?.code).toBe("23514");
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("coordinate columns and functions are closed to authenticated", () => {
    async function denied(sql: string, params: unknown[] = []) {
      const err = await tryQuery(a(), sql, params);
      expect(err, sql).not.toBeNull();
      expect(err?.code, sql).toBe("42501");
      expect(err?.message, sql).toMatch(PERMISSION_DENIED);
      return err;
    }

    it("authenticated cannot execute encrypt_coord or read/write the encrypted columns", async () => {
      await sandbox(async () => {
        await admin1();
        const fn = await denied("SELECT public.encrypt_coord(1.5)");
        expect(fn?.message).toMatch(/permission denied for function/i);
        await denied("SELECT home_lat_enc FROM babies");
        await denied("SELECT home_lng_enc FROM babies");
        await denied("SELECT * FROM babies");
        await denied("SELECT raw_json FROM photo_exif");
        await denied(
          "INSERT INTO babies (name, birth_date, created_by, home_lat_enc) VALUES ('x', '2026-01-01', $1, '\\x00')",
          [U.adminA1],
        );
        await denied(
          "INSERT INTO babies (name, birth_date, created_by, home_lng_enc) VALUES ('x', '2026-01-01', $1, '\\x00')",
          [U.adminA1],
        );
        await denied("UPDATE babies SET home_lat_enc = '\\x00' WHERE id = $1", [BABY.A]);
        await denied("UPDATE babies SET home_lng_enc = '\\x00' WHERE id = $1", [BABY.A]);
      });
    });

    it("pipeline and service_role can still call encrypt_coord (with the key as a bind parameter)", async () => {
      for (const role of ["pipeline", "service_role"]) {
        await sandbox(async () => {
          await as(role);
          await q("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
          const r = await q("SELECT public.decrypt_coord(public.encrypt_coord(47.5)) AS v");
          expect((r.rows[0] as { v: number }).v).toBeCloseTo(47.5);
        });
      }
    });

    it("the real pipeline login (littlelight_worker) can call encrypt_coord", async () => {
      await db.asPipeline(async (c) => {
        await c.query("SELECT set_config('app.data_key', $1, true)", [DATA_KEY]);
        const r = await c.query("SELECT public.encrypt_coord(1.25) AS v");
        expect(r.rowCount).toBe(1);
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("catalog: trigger functions are not callable by app roles", () => {
    it("no public trigger function grants EXECUTE to PUBLIC, authenticated, viewer or pipeline", async () => {
      const fns = await q(
        `SELECT p.oid, p.proname,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                         WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS to_public,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('viewer', p.oid, 'EXECUTE') AS viewer,
                has_function_privilege('pipeline', p.oid, 'EXECUTE') AS pipeline
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
          ORDER BY p.proname`,
      );
      // Sanity: the catalog query really sees the trigger functions the migrations create.
      const names = fns.rows.map((r: { proname: string }) => r.proname);
      expect(names.length).toBeGreaterThanOrEqual(10);
      expect(names).toContain("baby_members_consume_invite");
      expect(names).toContain("photo_exif_no_gps_keys");
      expect(names).toContain("photos_sensitive_unshare_rules");

      const offenders = fns.rows.filter(
        (r: Record<string, boolean>) => r.to_public || r.authenticated || r.viewer || r.pipeline,
      );
      expect(offenders.map((r: { proname: string }) => r.proname)).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("bootstrap failure redaction", () => {
    const LOW = "fx_bootstrap_lowpriv";
    const LOW_PW = "fx-low-priv-pw";

    afterAll(async () => {
      if (db) await db.admin.query(`DROP ROLE IF EXISTS ${LOW}`).catch(() => undefined);
    });

    it("a failure inside the DO block surfaces the message with passwords masked and no PASSWORD text", async () => {
      // A login without CREATEROLE makes the first ALTER ROLE fail ("permission denied to alter
      // role"). The three passwords are words from that message, so an unmasked message would
      // contain them verbatim.
      await db.admin.query(`DROP ROLE IF EXISTS ${LOW}`);
      await db.admin.query(`CREATE ROLE ${LOW} LOGIN PASSWORD '${LOW_PW}'`);
      const url = new URL(databaseUrl as string);
      url.username = LOW;
      url.password = LOW_PW;

      let message = "";
      try {
        await bootstrap({
          databaseUrl: url.toString(),
          authDbPassword: "permission",
          apiDbPassword: "denied",
          workerDbPassword: "role",
          log: () => undefined,
        });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/^bootstrap failed:/);
      expect(message).toContain("[redacted]");
      expect(message).not.toMatch(/permission|denied/);
      expect(message).not.toMatch(/PASSWORD/i);
      expect(message).not.toMatch(/CONTEXT|PL\/pgSQL/i);
      expect(message).not.toContain(LOW_PW);
      // SQLSTATE survival cannot be asserted here: bootstrap() wraps the error in a plain Error.
    });
  });
});
