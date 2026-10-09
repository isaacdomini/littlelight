import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// packages/db has no dependency on @littlelight/shared: relative import on purpose.
import { MILESTONE_PRESETS } from "../shared/src/constants";
import { bootstrapFromEnv, ensureAuthSchemaStub, runMigrations } from "./src/index";
import { databaseUrl, env } from "./test/harness";

// Migration round trip against a real Postgres (pgvector image). Skipped when DATABASE_URL is
// unset. Needs AUTH_DB_PASSWORD / API_DB_PASSWORD / WORKER_DB_PASSWORD / DATA_ENCRYPTION_KEY /
// SEED_DEMO_FAMILY for the bootstrap, migrate and seed steps (defaults below are the dev values).
// auth.users is created by GoTrue in the dev stack; on a bare pgvector (CI) the harness stubs it.
// WARNING: reverts every migration, so only point it at a disposable database.

const EXPECTED_MIGRATIONS = 15;
const quiet = () => undefined;

const APP_TABLES = [
  "ai_batch_items",
  "ai_batches",
  "ai_spend",
  "audit_log",
  "babies",
  "baby_members",
  "chat_messages",
  "chat_threads",
  "chat_turns",
  "invites",
  "measurements",
  "milestones",
  "photo_ai",
  "photo_ai_overrides",
  "photo_derivatives",
  "photo_details",
  "photo_exif",
  "photo_search",
  "photos",
  "profiles",
  "share_links",
  "share_passcode_failures",
  "share_rules",
  "shared_photo_exclusions",
  "shared_photos",
  "upload_files",
  "upload_sessions",
  "viewer_sessions",
  "worker_heartbeats",
];

describe.skipIf(!databaseUrl)("db migrations round trip", () => {
  let client: pg.Client;
  const run = (opts: Parameters<typeof runMigrations>[0]) =>
    runMigrations({ databaseUrl, env, log: quiet, ...opts });
  const down = () => run({ direction: "down", count: Number.POSITIVE_INFINITY, bootstrap: false });

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // Start from a clean slate regardless of earlier state, then make auth.users exist the way
    // CI does (no-op where GoTrue already created it).
    await down();
    await ensureAuthSchemaStub(client);
  });

  afterAll(async () => {
    // Leave the database migrated, as the dev stack expects.
    await run({ direction: "up" });
    await client.end();
  });

  const rows = async (sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as Record<string, unknown>[];
  const scalar = async (sql: string) => (await rows(sql))[0] as Record<string, unknown>;

  it("applies all migrations up", async () => {
    const applied = await run({ direction: "up" });
    expect(applied.length).toBe(EXPECTED_MIGRATIONS);
    expect(applied.map((m) => m.name)).toEqual([...applied.map((m) => m.name)].sort());
    const { n } = await scalar("SELECT count(*)::int AS n FROM public.pgmigrations");
    expect(n).toBe(EXPECTED_MIGRATIONS);
    const ext = await client.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto') ORDER BY 1",
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(["pgcrypto", "vector"]);
  });

  it("creates every table of the data model", async () => {
    const t = await rows(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = 'public' AND relkind = 'r' AND relname <> 'pgmigrations' ORDER BY 1",
    );
    expect(t.map((r) => r.relname)).toEqual(APP_TABLES);
  });

  it("enables AND forces row-level security on every public table (only pgmigrations exempt)", async () => {
    const t = await rows(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE nspname = 'public' AND relkind = 'r' AND NOT (relrowsecurity AND relforcerowsecurity)
        ORDER BY 1`,
    );
    expect(t.map((r) => r.relname)).toEqual(["pgmigrations"]);
  });

  it("every RLS table has at least one policy, and no policy is granted to PUBLIC", async () => {
    const withPolicy = await rows(
      "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'",
    );
    const set = new Set(withPolicy.map((r) => r.tablename));
    // chat_turns is deny-all by design (and share_passcode_failures, step 8) (FORCE RLS, no policy, no grant but service_role): it is
    // reached only through SECURITY DEFINER functions (search-chat.integration.test.ts).
    const denyAll = new Set(["chat_turns", "share_passcode_failures"]);
    for (const table of APP_TABLES) {
      if (denyAll.has(table)) {
        expect(set.has(table), `${table} must stay policy-less (deny-all)`).toBe(false);
      } else {
        expect(set.has(table), `${table} has no policy`).toBe(true);
      }
    }
    const pub = await rows(
      "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND 'public' = ANY(roles)",
    );
    expect(pub).toEqual([]);
    const misnamed = await rows(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
         AND policyname !~ ('^' || tablename || '_(authenticated|viewer|pipeline|worker)_(select|insert|update|delete|all)$')`,
    );
    expect(misnamed).toEqual([]);
  });

  it("seeds the global milestone presets exactly as @littlelight/shared MILESTONE_PRESETS", async () => {
    const r = await rows(
      "SELECT id, name, category, sort_order FROM public.milestones WHERE baby_id IS NULL ORDER BY sort_order, id",
    );
    expect(
      r.map((x) => ({ id: x.id, name: x.name, category: x.category, sortOrder: x.sort_order })),
    ).toEqual(MILESTONE_PRESETS.map((p) => ({ ...p })));
    expect(MILESTONE_PRESETS).toHaveLength(12);
  });

  it("role model: login roles are not superuser/BYPASSRLS; service_role BYPASSRLS; pipeline not", async () => {
    const r = await rows(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1`,
      [
        [
          "anon",
          "authenticated",
          "viewer",
          "pipeline",
          "service_role",
          "littlelight_api",
          "littlelight_worker",
          "supabase_auth_admin",
        ],
      ],
    );
    const by = Object.fromEntries(r.map((x) => [x.rolname as string, x]));
    expect(Object.keys(by).sort()).toEqual([
      "anon",
      "authenticated",
      "littlelight_api",
      "littlelight_worker",
      "pipeline",
      "service_role",
      "supabase_auth_admin",
      "viewer",
    ]);
    for (const name of ["littlelight_api", "littlelight_worker"]) {
      expect(by[name], name).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
    }
    for (const name of ["anon", "authenticated", "viewer", "pipeline", "service_role"]) {
      expect(by[name], name).toMatchObject({ rolcanlogin: false, rolsuper: false });
    }
    expect(by.service_role?.rolbypassrls).toBe(true);
    for (const name of [
      "anon",
      "authenticated",
      "viewer",
      "pipeline",
      "littlelight_api",
      "littlelight_worker",
    ]) {
      expect(by[name]?.rolbypassrls, name).toBe(false);
    }
    // No login role anywhere (besides the superuser) may bypass RLS or be superuser.
    const risky = await rows(
      "SELECT rolname FROM pg_roles WHERE rolcanlogin AND (rolbypassrls OR rolsuper) AND rolname <> 'postgres' ORDER BY 1",
    );
    expect(risky).toEqual([]);
  });

  it("role memberships are SET-only (no INHERIT): api -> authenticated/viewer/service_role, worker -> pipeline", async () => {
    const r = await rows(
      `SELECT g.rolname AS grantee, m.rolname AS member, am.inherit_option, am.set_option
         FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
        WHERE m.rolname IN ('littlelight_api', 'littlelight_worker') ORDER BY 2, 1`,
    );
    expect(r.map((x) => `${x.member}->${x.grantee}`)).toEqual([
      "littlelight_api->authenticated",
      "littlelight_api->service_role",
      "littlelight_api->viewer",
      "littlelight_worker->pipeline",
    ]);
    for (const x of r)
      expect(x, `${x.member}->${x.grantee}`).toMatchObject({
        inherit_option: false,
        set_option: true,
      });
  });

  it("pg-boss schema belongs to the worker role", async () => {
    const r = await scalar(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'",
    );
    expect(r.owner).toBe("littlelight_worker");
  });

  it("nothing in public is reachable through PUBLIC: tables, sequences and helper functions", async () => {
    const tables = await rows(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v')
          AND c.relacl IS NOT NULL AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0)`,
    );
    expect(tables).toEqual([]);
    const fns = await rows(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prorettype <> 'trigger'::regtype
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
          AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
        ORDER BY 1`,
    );
    expect(fns, "functions executable by PUBLIC").toEqual([]);
    const schema = await scalar(
      "SELECT has_schema_privilege('anon', 'public', 'USAGE') AS anon_usage, has_schema_privilege('anon', 'public', 'CREATE') AS anon_create",
    );
    expect(schema).toEqual({ anon_usage: false, anon_create: false });
  });

  it("every SECURITY DEFINER function pins its search_path (no hijack via search_path)", async () => {
    const r = await rows(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
    );
    expect(r.length).toBeGreaterThan(5);
    for (const f of r) {
      expect((f.proconfig as string[] | null) ?? [], String(f.proname)).toContain(
        "search_path=pg_catalog, public",
      );
    }
  });

  it("only the postgres superuser can read pgmigrations or auth.*", async () => {
    const r = await scalar(
      `SELECT bool_or(has_table_privilege(role, 'public.pgmigrations', 'SELECT')) AS mig,
              bool_or(has_table_privilege(role, 'auth.users', 'SELECT')) AS users
         FROM unnest(ARRAY['anon','authenticated','viewer','pipeline','service_role','littlelight_api','littlelight_worker']) AS role`,
    );
    expect(r).toEqual({ mig: false, users: false });
  });

  it("the worker_heartbeats table is reachable only by the worker login role", async () => {
    const r = await scalar(
      `SELECT has_table_privilege('littlelight_worker', 'public.worker_heartbeats', 'SELECT,INSERT,UPDATE,DELETE') AS worker,
              has_table_privilege('littlelight_api', 'public.worker_heartbeats', 'SELECT') AS api,
              has_table_privilege('authenticated', 'public.worker_heartbeats', 'SELECT') AS authed,
              has_table_privilege('pipeline', 'public.worker_heartbeats', 'SELECT') AS pipeline,
              has_table_privilege('anon', 'public.worker_heartbeats', 'SELECT') AS anon`,
    );
    expect(r).toEqual({ worker: true, api: false, authed: false, pipeline: false, anon: false });
  });

  it("bootstrap is idempotent: a second run changes no role attribute or membership", async () => {
    const snapshot = async () => ({
      roles: await rows(
        "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolconnlimit FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1",
      ),
      members: await rows(
        "SELECT roleid::regrole::text AS r, member::regrole::text AS m, inherit_option, set_option FROM pg_auth_members WHERE member::regrole::text !~ '^pg_' AND roleid::regrole::text !~ '^pg_' ORDER BY 1, 2",
      ),
      boss: await rows(
        "SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'pgboss'",
      ),
    });
    const before = await snapshot();
    await bootstrapFromEnv(env, quiet);
    await bootstrapFromEnv(env, quiet);
    expect(await snapshot()).toEqual(before);
  });

  it("the app roles can actually log in with their passwords (api, worker)", async () => {
    for (const [user, password] of [
      ["littlelight_api", env.API_DB_PASSWORD],
      ["littlelight_worker", env.WORKER_DB_PASSWORD],
    ] as const) {
      const url = new URL(databaseUrl as string);
      url.username = user;
      url.password = password;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      const r = await c.query("SELECT current_user AS u");
      expect(r.rows[0]?.u).toBe(user);
      await c.end();
    }
  });

  it("denies the authenticated and anon roles any access to worker_heartbeats", async () => {
    for (const role of ["authenticated", "anon"]) {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE ${role}`);
        await expect(client.query("SELECT * FROM public.worker_heartbeats")).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await client.query("ROLLBACK");
      }
    }
  });

  it("worker_heartbeats: an epoch last_seen_at with a fresh updated_at survives the S5 prune", async () => {
    // Uses the exact PRUNE_SQL the worker ships.
    const { PRUNE_SQL } = await import("../../apps/worker/src/heartbeat");
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO worker_heartbeats (worker_id, hostname, pid, version, started_at, last_seen_at, storage_ok, details, updated_at)
         VALUES ('t-live-no-storage', 'h', 1, 'v', now(), to_timestamp(0), false, '{}', now()),
                ('t-dead', 'h', 2, 'v', now(), to_timestamp(0), false, '{}', now() - interval '2 days'),
                ('t-self', 'h', 3, 'v', now(), to_timestamp(0), false, '{}', now() - interval '2 days')`,
      );
      await client.query(PRUNE_SQL, ["t-self"]);
      const left = await client.query(
        "SELECT worker_id FROM worker_heartbeats WHERE worker_id LIKE 't-%' ORDER BY 1",
      );
      expect(left.rows.map((r) => r.worker_id)).toEqual(["t-live-no-storage", "t-self"]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("is idempotent: a second up applies nothing", async () => {
    expect(await run({ direction: "up" })).toEqual([]);
  });

  it("reverts everything down, leaving no application objects behind", async () => {
    const reverted = await down();
    expect(reverted.length).toBe(EXPECTED_MIGRATIONS);
    const { n } = await scalar("SELECT count(*)::int AS n FROM public.pgmigrations");
    expect(n).toBe(0);
    const leftoverTables = await rows(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = 'public' AND relkind IN ('r','v','m','S') AND relname NOT LIKE 'pgmigrations%' ORDER BY 1",
    );
    expect(leftoverTables).toEqual([]);
    const fns = await rows(
      "SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = 'public' ORDER BY 1",
    );
    expect(fns, "functions left behind").toEqual([]);
    const stepFour = await rows(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE nspname = 'public' AND proname IN ('home_place_label', 'free_tier_photo_count',
          'baby_has_quarantined_photos', 'upload_session_visible', 'upload_files_session_owner')`,
    );
    expect(stepFour, "step 4 helpers left behind").toEqual([]);
    const cols = await rows(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'quarantined_at'",
    );
    expect(cols).toEqual([]);
    const stepFive = await rows(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE nspname = 'public' AND proname = ANY($1)`,
      [
        [
          "age_group",
          "member_baby_ids",
          "admin_baby_ids",
          "milestones_cap",
          "milestones_name_guard",
          "photo_details_shape",
          "measurements_photo_same_baby",
          "measurements_shape",
          "babies_shape",
          "upload_sessions_shape",
          "share_links_shape",
          "chat_threads_shape",
          "invites_shape",
          "photo_ai_overrides_shape",
        ],
      ],
    );
    expect(stepFive, "step 5 helpers left behind").toEqual([]);
    const stepFiveCols = await rows(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND ((table_name = 'photos' AND column_name = 'sort_at')
           OR (table_name = 'milestones' AND column_name = 'updated_at'))`,
    );
    expect(stepFiveCols, "step 5 columns left behind").toEqual([]);
    const policies = await rows("SELECT policyname FROM pg_policies WHERE schemaname = 'public'");
    expect(policies).toEqual([]);
    const table = await scalar("SELECT to_regclass('public.worker_heartbeats') AS t");
    expect(table.t).toBeNull();
    const ext = await client.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')",
    );
    expect(ext.rows).toEqual([]);
    // Default privileges granted to service_role in public were revoked as well.
    const defacl = await rows(
      "SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = 'public'",
    );
    expect(defacl).toEqual([]);
    // Roles survive (cluster-level, owned by the bootstrap).
    const roles = await rows(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('littlelight_api','pipeline','viewer')",
    );
    expect(roles).toHaveLength(3);
  });

  it("applies cleanly up again after a full down, then is a no-op", async () => {
    expect((await run({ direction: "up" })).length).toBe(EXPECTED_MIGRATIONS);
    expect(await run({ direction: "up" })).toEqual([]);
    const table = await scalar("SELECT to_regclass('public.worker_heartbeats') AS t");
    expect(table.t).not.toBeNull();
    const p = await scalar("SELECT count(*)::int n FROM public.milestones WHERE baby_id IS NULL");
    expect(p.n).toBe(MILESTONE_PRESETS.length);
  });

  it("migrating a database without auth.users fails loudly with the guard message and applies nothing", async () => {
    const name = `ll_guard_${process.pid}`;
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
    await client.query(`CREATE DATABASE ${name}`);
    try {
      const url = new URL(databaseUrl as string);
      url.pathname = `/${name}`;
      await expect(
        runMigrations({ direction: "up", databaseUrl: url.toString(), env, log: quiet }),
      ).rejects.toThrow(/auth\.users is missing/);
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        const left = await c.query(
          "SELECT to_regclass('public.babies') AS t, to_regclass('public.photos') AS p",
        );
        expect(left.rows[0]).toEqual({ t: null, p: null });
      } finally {
        await c.end();
      }
    } finally {
      await client.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  });

  it("bootstrap and migrate fail by field name, never echoing values, when a password is missing", async () => {
    const { API_DB_PASSWORD: _a, ...noApi } = env;
    await expect(bootstrapFromEnv({ ...noApi, API_DB_PASSWORD: "" }, quiet)).rejects.toThrow(
      /API_DB_PASSWORD/,
    );
    const { WORKER_DB_PASSWORD: _w, ...noWorker } = env;
    await expect(bootstrapFromEnv(noWorker, quiet)).rejects.toThrow(/WORKER_DB_PASSWORD/);
    const long = "x".repeat(32);
    const prod = {
      ...env,
      NODE_ENV: "production",
      AUTH_DB_PASSWORD: long,
      WORKER_DB_PASSWORD: long,
      API_DB_PASSWORD: "short-pw",
    };
    const err = await bootstrapFromEnv(prod, quiet).catch((e) => e as Error);
    expect((err as Error).message).toMatch(/API_DB_PASSWORD/);
    expect((err as Error).message).not.toContain("short-pw");
  });
});
