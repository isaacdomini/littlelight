import { randomUUID } from "node:crypto";
import { appRoleUrl, ensureAuthSchemaStub, runMigrations } from "@littlelight/db";
import { PRIVACY_VERSION, TERMS_VERSION } from "@littlelight/shared";
import type { FastifyInstance, FastifyServerOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { buildApp } from "../app";
import { GoTrueError, type VerifyInput } from "../auth/gotrue";
import type { ApiConfig } from "../config";
import { type CaptureMailer, captureMailer } from "../email/mailer";
import type { AiServices } from "../plugins/ai";
import type { JobQueue } from "../plugins/jobs";
import type { StorageClient } from "../plugins/storage";
import type { UrlSigner } from "../storage/sign";
import {
  type FullGoTrueClient,
  type GoTrueStub,
  gotrueSession,
  signAccessToken,
  stubGoTrue,
  testConfig,
} from "./support";

// Shared harness for `*.integration.test.ts` in apps/api (docs/plans/step-3.md 3.10). These run
// against a migrated Postgres (`DATABASE_URL`, the superuser URL, as in packages/db) and skip
// when it is unset. The app under test uses a real `littlelight_api` pool, so every query goes
// through `runAs` exactly like production; the superuser client `admin` is for fixtures and for
// asserting persisted state only. GoTrue is a recording stub, mail is `captureMailer()`.
//
// GoTrue stub defaults that touch the database (each overridable via `opts.gotrue` or
// `h.gotrue.impl.<method> = …`):
// - `adminDeleteUser` deletes the `auth.users` row (GoTrue's hard delete cascades).
// - `adminGenerateMagicLink(email)` (step 9 review sign-in) finds the non-SSO `auth.users` row for
//   the email or creates one (as GoTrue does; tracked for `close()`), and returns its id with a
//   fresh single-use hashed token. No email is captured (GoTrue sends none for admin links).
// - `verify({kind:"token_hash"})` redeems a token issued by that fake once: it inserts a live
//   `auth.sessions` row and returns a signed session for the user; a second redemption is
//   GoTrue's 403 `otp_expired`. Any other `verify` input throws "unexpected GoTrue call: verify",
//   exactly like the plain stub, so tests that never set `verify` behave as before.

export const databaseUrl = process.env.DATABASE_URL;

const env = {
  ...process.env,
  AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD ?? "dev",
  API_DB_PASSWORD: process.env.API_DB_PASSWORD ?? "dev",
  WORKER_DB_PASSWORD: process.env.WORKER_DB_PASSWORD ?? "dev",
  DATA_ENCRYPTION_KEY:
    process.env.DATA_ENCRYPTION_KEY ?? "dev-only-data-encryption-key-32-chars-min",
};

/** Bare pgvector (CI, throwaway container): stub auth.*, then bootstrap + migrate. Idempotent. */
export async function ensureMigrated(): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await ensureAuthSchemaStub(c);
  } finally {
    await c.end();
  }
  await runMigrations({ direction: "up", databaseUrl, env, log: () => undefined });
}

export interface TestUser {
  id: string;
  email: string;
  sessionId: string;
  token: string;
  /** `authorization: Bearer …` (no CSRF header needed). */
  headers: Record<string, string>;
  displayName: string;
}

export interface UserOptions {
  email?: string;
  displayName?: string;
  /** Default true: profile row with the current Terms/Privacy versions accepted. */
  consent?: boolean;
  /** Default true: create the profile row at all (false mimics a user who never signed in via the API). */
  profile?: boolean;
  /** Minutes ago the GoTrue session was created; > 10 means "not fresh". Default 1. */
  sessionAgeMin?: number;
  userAgent?: string;
}

let counter = 0;

export interface Harness {
  admin: pg.Client;
  app: FastifyInstance;
  config: ApiConfig;
  mailer: CaptureMailer;
  gotrue: GoTrueStub;
  user(opts?: UserOptions): Promise<TestUser>;
  /** Another live GoTrue session for the same user (a second device). */
  session(
    user: TestUser,
    opts?: { ageMin?: number; userAgent?: string },
  ): Promise<{ id: string; token: string }>;
  /** Insert a membership directly (fixtures). */
  member(babyId: string, user: TestUser, role: "admin" | "contributor"): Promise<void>;
  /** Create a baby through the API as `user` (first admin via the trigger). Returns its id. */
  baby(user: TestUser, name?: string): Promise<string>;
  inject(
    user: TestUser | null,
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  audit(filter: { event?: string; actor?: string; baby?: string }): Promise<
    {
      event: string;
      actor_user_id: string | null;
      baby_id: string | null;
      metadata: Record<string, unknown>;
    }[]
  >;
  /** Delete everything the harness created and close connections. */
  close(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<ApiConfig>;
  gotrue?: Partial<FullGoTrueClient>;
  /** Default true. `false`: the GoTrue stub lacks `adminGenerateMagicLink` (review 503 path). */
  gotrueReviewLinks?: boolean;
  /** S3 stub (default: answers `{}` to everything; use `createS3Stub()` for uploads). */
  s3?: StorageClient;
  /** Job queue stub (default: the real lazy pg-boss, which the tests never trigger). */
  jobs?: JobQueue;
  signer?: UrlSigner;
  /** Chat model + embedder (fakes). Default: whatever `process.env` builds (no key => none). */
  ai?: AiServices;
  /** Fastify logger options, e.g. `{ ...loggerOptions(config), level: "info", stream }`. */
  logger?: FastifyServerOptions["logger"];
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  await ensureMigrated();
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const startAuditId = Number(
    (await admin.query("SELECT COALESCE(max(id), 0) AS m FROM public.audit_log")).rows[0].m,
  );
  const config = testConfig({
    DATABASE_URL: appRoleUrl(databaseUrl, "littlelight_api", env.API_DB_PASSWORD),
    ...opts.config,
  });
  const mailer = captureMailer();
  const users: string[] = [];
  const babies = new Set<string>();
  /** Hashed tokens issued by the fake `adminGenerateMagicLink`, until redeemed by `verify`. */
  const magicLinks = new Map<string, { userId: string; email: string; used: boolean }>();
  const gotrue = stubGoTrue(
    {
      // Realistic default: GoTrue's hard delete cascades through auth.users.
      adminDeleteUser: async (uid: string) => {
        await admin.query("DELETE FROM auth.users WHERE id = $1", [uid]);
      },
      adminGenerateMagicLink: async (email: string) => {
        const normalized = email.trim().toLowerCase();
        const found = await admin.query<{ id: string }>(
          "SELECT id FROM auth.users WHERE lower(email) = $1 AND is_sso_user = false",
          [normalized],
        );
        let userId = found.rows[0]?.id;
        if (!userId) {
          userId = randomUUID();
          await admin.query(
            `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
             VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
            [userId, normalized],
          );
          users.push(userId);
        }
        const hashedToken = `fake-hashed-${randomUUID()}`;
        magicLinks.set(hashedToken, { userId, email: normalized, used: false });
        return { userId, hashedToken };
      },
      verify: async (input: VerifyInput) => {
        const link = input.kind === "token_hash" ? magicLinks.get(input.tokenHash) : undefined;
        if (!link) throw new Error("unexpected GoTrue call: verify");
        if (link.used) throw new GoTrueError(403, "otp_expired");
        link.used = true;
        const sessionId = await insertSession(link.userId, 0);
        return gotrueSession({ sub: link.userId, email: link.email, sessionId });
      },
      ...opts.gotrue,
    },
    { reviewLinks: opts.gotrueReviewLinks !== false },
  );
  const app = await buildApp({
    config,
    mailer,
    gotrue,
    s3: opts.s3 ?? { send: (async () => ({})) as never, destroy: () => undefined },
    ...(opts.jobs ? { jobs: opts.jobs } : {}),
    ...(opts.signer ? { signer: opts.signer } : {}),
    ...(opts.ai ? { ai: opts.ai } : { aiEnv: {} }),
    logger: opts.logger ?? false,
  });

  async function insertSession(userId: string, ageMin: number, userAgent?: string) {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO auth.sessions (id, user_id, created_at, updated_at, user_agent, ip)
       VALUES ($1, $2, now() - make_interval(mins => $3), now(), $4, '203.0.113.5')`,
      [
        id,
        userId,
        ageMin,
        userAgent ?? "Mozilla/5.0 (Macintosh) AppleWebKit Chrome/120 Safari/537",
      ],
    );
    return id;
  }

  const h: Harness = {
    admin,
    app,
    config,
    mailer,
    gotrue,

    async user(o = {}) {
      const id = randomUUID();
      const n = ++counter;
      const email = o.email ?? `t${n}-${id.slice(0, 8)}@example.test`;
      const displayName = o.displayName ?? `User ${n}`;
      await admin.query(
        `INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
         VALUES ($1, 'authenticated', 'authenticated', $2, now(), now())`,
        [id, email],
      );
      users.push(id);
      if (o.profile !== false) {
        const consent = o.consent !== false;
        await admin.query(
          `INSERT INTO public.profiles (user_id, display_name, terms_version, privacy_version, accepted_at)
           VALUES ($1, $2, $3, $4, ${consent ? "now()" : "NULL"})`,
          [id, displayName, consent ? TERMS_VERSION : null, consent ? PRIVACY_VERSION : null],
        );
      }
      const sessionId = await insertSession(id, o.sessionAgeMin ?? 1, o.userAgent);
      const token = await signAccessToken({ sub: id, email, sessionId });
      return {
        id,
        email,
        sessionId,
        token,
        headers: { authorization: `Bearer ${token}` },
        displayName,
      };
    },

    async session(user, o = {}) {
      const id = await insertSession(user.id, o.ageMin ?? 1, o.userAgent);
      return {
        id,
        token: await signAccessToken({ sub: user.id, email: user.email, sessionId: id }),
      };
    },

    async member(babyId, user, role) {
      await admin.query(
        "INSERT INTO public.baby_members (baby_id, user_id, role) VALUES ($1, $2, $3)",
        [babyId, user.id, role],
      );
    },

    async baby(user, name = "Mia") {
      const res = await h.inject(user, "POST", "/babies", { name, birthDate: "2026-03-01" });
      if (res.statusCode !== 201)
        throw new Error(`baby create failed: ${res.statusCode} ${res.body}`);
      const id = res.json().id as string;
      babies.add(id);
      return id;
    },

    inject(user, method, url, payload, headers = {}) {
      return app.inject({
        method,
        url,
        headers: { ...(user ? user.headers : {}), ...headers },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    },

    async audit(filter) {
      const where: string[] = ["id > $1"];
      const vals: unknown[] = [startAuditId];
      if (filter.event) where.push(`event = $${vals.push(filter.event)}`);
      if (filter.actor) where.push(`actor_user_id = $${vals.push(filter.actor)}`);
      if (filter.baby) where.push(`baby_id = $${vals.push(filter.baby)}`);
      const { rows } = await admin.query(
        `SELECT event, actor_user_id, baby_id, metadata FROM public.audit_log WHERE ${where.join(" AND ")} ORDER BY id`,
        vals,
      );
      return rows;
    },

    async close() {
      await app.close();
      try {
        // Babies created via the API (and any created directly under our users).
        const { rows } = await admin.query<{ baby_id: string }>(
          "SELECT DISTINCT baby_id FROM public.baby_members WHERE user_id = ANY($1::uuid[])",
          [users],
        );
        for (const r of rows) babies.add(r.baby_id);
        await admin.query(
          "DELETE FROM public.audit_log WHERE id > $1 AND (actor_user_id = ANY($2::uuid[]) OR baby_id = ANY($3::uuid[]) OR (actor_user_id IS NULL AND event LIKE 'account.%'))",
          [startAuditId, users, [...babies]],
        );
        await admin.query("DELETE FROM public.babies WHERE id = ANY($1::uuid[])", [[...babies]]);
        await admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [users]);
      } finally {
        await admin.end();
      }
    },
  };
  return h;
}
