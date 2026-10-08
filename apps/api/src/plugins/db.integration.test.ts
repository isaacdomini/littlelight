import { randomUUID } from "node:crypto";
import { appRoleUrl } from "@littlelight/db";
import { claimsToSql } from "@littlelight/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, ensureMigrated } from "../testing/integration";
import { TEST_DATA_KEY } from "../testing/support";
import { runAs, TransactionAbortedError } from "./db";

// runAs against a real littlelight_api connection (docs/plans/step-3.md 2.7; packages/db/README.md
// "Per-transaction identity"). One-connection pool: the connection a call used is exactly the one
// the next call gets, so "nothing leaks to the next request" is directly observable.

interface Residue {
  user: string;
  claims: string | null;
  dataKey: string | null;
  inTx: boolean;
}

describe.skipIf(!databaseUrl)("runAs", () => {
  let pool: pg.Pool;
  let admin: pg.Client;
  const uid = randomUUID();
  const claimsJson = () =>
    claimsToSql({
      sub: uid,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: randomUUID(),
    });

  beforeAll(async () => {
    await ensureMigrated();
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    pool = new pg.Pool({
      connectionString: appRoleUrl(
        databaseUrl as string,
        "littlelight_api",
        process.env.API_DB_PASSWORD ?? "dev",
      ),
      max: 1,
    });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  /** What the next borrower of the (only) pooled connection would inherit. */
  async function residue(): Promise<Residue> {
    const c = await pool.connect();
    try {
      const { rows } = await c.query(
        `SELECT current_user AS "user",
                nullif(current_setting('request.jwt.claims', true), '') AS claims,
                nullif(current_setting('app.data_key', true), '') AS "dataKey",
                (txid_current_if_assigned() IS NOT NULL) AS "inTx"`,
      );
      return rows[0];
    } finally {
      c.release();
    }
  }
  const CLEAN = { user: "littlelight_api", claims: null, dataKey: null, inTx: false };

  it("a fresh connection is littlelight_api with no claims or key", async () => {
    expect(await residue()).toEqual(CLEAN);
  });

  it("sets role, claims and data key inside the transaction, and leaves nothing behind", async () => {
    const json = claimsJson();
    const seen = await runAs(
      pool,
      "authenticated",
      { claimsJson: json, dataKey: TEST_DATA_KEY },
      async (c) => {
        const { rows } = await c.query(
          `SELECT current_user AS "user", current_setting('request.jwt.claims', true) AS claims,
                current_setting('app.data_key', true) AS key, public.auth_uid() AS uid`,
        );
        return rows[0];
      },
    );
    expect(seen.user).toBe("authenticated");
    expect(JSON.parse(seen.claims)).toMatchObject({ sub: uid, role: "authenticated" });
    expect(seen.key).toBe(TEST_DATA_KEY);
    expect(seen.uid).toBe(uid);
    expect(await residue()).toEqual(CLEAN);
  });

  it("supports viewer and service_role", async () => {
    for (const role of ["viewer", "service_role"] as const) {
      const who = await runAs(
        pool,
        role,
        {},
        async (c) => (await c.query("SELECT current_user AS u")).rows[0].u,
      );
      expect(who).toBe(role);
      expect(await residue()).toEqual(CLEAN);
    }
  });

  it("without claims the identity helpers return null (no claims leak in from earlier calls)", async () => {
    await runAs(pool, "authenticated", { claimsJson: claimsJson() }, async () => undefined);
    const uidSeen = await runAs(
      pool,
      "authenticated",
      {},
      async (c) => (await c.query("SELECT public.auth_uid() AS u")).rows[0].u,
    );
    expect(uidSeen).toBeNull();
  });

  it("commits writes made by fn", async () => {
    await runAs(pool, "service_role", {}, async (c) => {
      await c.query("CREATE TEMP TABLE runas_commit (n int)");
      await c.query("INSERT INTO runas_commit VALUES (1)");
    });
    // TEMP table vanished with DISCARD ALL, proving session state was reset too.
    const c = await pool.connect();
    try {
      const { rows } = await c.query("SELECT to_regclass('pg_temp.runas_commit') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      c.release();
    }
  });

  it("rolls back everything fn did when it throws, rethrows the original error, and cleans up", async () => {
    const marker = `runas-rollback-${randomUUID()}`;
    await expect(
      runAs(pool, "service_role", {}, async (c) => {
        await c.query(
          "INSERT INTO public.milestones (name, category, sort_order) VALUES ($1, 'social', 999999)",
          [marker],
        );
        throw new Error("fn failed");
      }),
    ).rejects.toThrow("fn failed");
    const { rows } = await admin.query("SELECT 1 FROM public.milestones WHERE name = $1", [marker]);
    expect(rows).toHaveLength(0);
    expect(await residue()).toEqual(CLEAN);
  });

  it("rolls back and leaves a clean connection when a statement fails inside fn", async () => {
    await expect(
      runAs(pool, "authenticated", { claimsJson: claimsJson() }, async (c) => {
        await c.query("SELECT * FROM public.babies"); // column-level grants: SELECT * is denied
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await residue()).toEqual(CLEAN);
  });

  it("a swallowed statement error becomes TransactionAbortedError and nothing is committed", async () => {
    const marker = `runas-swallow-${randomUUID()}`;
    await expect(
      runAs(pool, "service_role", {}, async (c) => {
        await c.query(
          "INSERT INTO public.milestones (name, category, sort_order) VALUES ($1, 'social', 999998)",
          [marker],
        );
        try {
          await c.query("SELECT 1/0");
        } catch {
          // swallowed: the transaction is now aborted
        }
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    const { rows } = await admin.query("SELECT 1 FROM public.milestones WHERE name = $1", [marker]);
    expect(rows).toHaveLength(0);
    expect(await residue()).toEqual(CLEAN);
  });

  it("destroys a client whose backend was terminated mid-call and keeps serving afterwards", async () => {
    let pidBefore = 0;
    await expect(
      runAs(pool, "authenticated", { claimsJson: claimsJson() }, async (c) => {
        pidBefore = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await admin.query("SELECT pg_terminate_backend($1)", [pidBefore]);
        await new Promise((r) => setTimeout(r, 100));
        await c.query("SELECT 1");
      }),
    ).rejects.toBeDefined();
    // The dead client was destroyed, not returned: the next borrower gets a new backend.
    const c = await pool.connect();
    try {
      const { rows } = await c.query("SELECT pg_backend_pid() AS pid, current_user AS u");
      expect(rows[0].pid).not.toBe(pidBefore);
      expect(rows[0].u).toBe("littlelight_api");
    } finally {
      c.release();
    }
    expect(await residue()).toEqual(CLEAN);
  });

  it("two concurrent calls on a one-connection pool serialise and never see each other's claims", async () => {
    const other = randomUUID();
    const a = runAs(pool, "authenticated", { claimsJson: claimsJson() }, async (c) => {
      await new Promise((r) => setTimeout(r, 50));
      return (await c.query("SELECT public.auth_uid() AS u")).rows[0].u as string;
    });
    const b = runAs(
      pool,
      "authenticated",
      {
        claimsJson: claimsToSql({
          sub: other,
          role: "authenticated",
          aud: "authenticated",
          exp: Math.floor(Date.now() / 1000) + 3600,
          session_id: randomUUID(),
        }),
      },
      async (c) => (await c.query("SELECT public.auth_uid() AS u")).rows[0].u as string,
    );
    expect(await Promise.all([a, b])).toEqual([uid, other]);
    expect(await residue()).toEqual(CLEAN);
  });

  it("plain littlelight_api has no table privileges of its own", async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("SELECT count(*) FROM public.profiles")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(c.query("SELECT count(*) FROM auth.sessions")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      c.release();
    }
  });
});
