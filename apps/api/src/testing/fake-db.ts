import { PRIVACY_VERSION, TERMS_VERSION } from "@tinyglow/shared";
import type pg from "pg";
import type { DbPool } from "../plugins/db";

// A scripted, connection-less database for route unit tests that must get THROUGH `withClaims`
// (liveness, consent, audit) without Postgres (docs/plans/step-13.md 2.8: the passkey routes).
// Every statement `runAs` issues is answered by shape: BEGIN/COMMIT/role/claims are no-ops,
// `auth_session_info` returns one live session (configurable age / suspension / absence), the
// profile row carries the current consent versions, `count_user_sessions` is 1, and audit inserts
// are recorded in `audits` so a test can assert on events and metadata. Anything else answers no
// rows. Test-only; never imported by a production module.

export interface FakeDbState {
  /** Minutes since the session was created (`isFresh` when <= 10). Default 1. */
  sessionAgeMin: number;
  /** `auth_session_info` returns no row (GoTrue deleted the session). Default false. */
  sessionGone: boolean;
  /** `profiles.suspended_at` set. Default false. */
  suspended: boolean;
  /** Profile accepted the current Terms/Privacy. Default true. */
  consent: boolean;
  /** `count_user_sessions()`; > 1 means "new device". Default 1. */
  liveSessions: number;
}

export interface RecordedAudit {
  event: string;
  actorUserId: string | null;
  babyId: string | null;
  metadata: Record<string, unknown>;
}

export interface FakeDb extends DbPool {
  state: FakeDbState;
  /** Every statement in order (`runAs` bookkeeping included). SQL text + bound parameters. */
  queries: { sql: string; params: unknown[] }[];
  /** `INSERT INTO public.audit_log` rows, decoded. */
  audits: RecordedAudit[];
  /** Hook: answer a statement yourself (return `undefined` to fall through to the defaults). */
  respond?: (sql: string, params: unknown[]) => { rows: unknown[] } | undefined;
}

export function fakeDb(initial: Partial<FakeDbState> = {}): FakeDb {
  const state: FakeDbState = {
    sessionAgeMin: 1,
    sessionGone: false,
    suspended: false,
    consent: true,
    liveSessions: 1,
    ...initial,
  };
  const queries: FakeDb["queries"] = [];
  const audits: RecordedAudit[] = [];

  const db: Partial<FakeDb> = { state, queries, audits };

  async function query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    const custom = db.respond?.(sql, params);
    if (custom) return { ...custom, command: "SELECT", rowCount: custom.rows.length };
    const s = sql.trim();
    if (/^COMMIT$/i.test(s)) return { rows: [], command: "COMMIT", rowCount: null };
    if (/auth_session_info/.test(s)) {
      if (state.sessionGone) return { rows: [], command: "SELECT", rowCount: 0 };
      return {
        rows: [
          {
            created_at: new Date(Date.now() - state.sessionAgeMin * 60_000),
            suspended: state.suspended,
          },
        ],
        command: "SELECT",
        rowCount: 1,
      };
    }
    if (/suspended_at IS NOT NULL AS suspended/.test(s)) {
      return { rows: [{ suspended: state.suspended }], command: "SELECT", rowCount: 1 };
    }
    if (/SELECT terms_version, privacy_version FROM public\.profiles/.test(s)) {
      return {
        rows: [
          state.consent
            ? { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION }
            : { terms_version: null, privacy_version: null },
        ],
        command: "SELECT",
        rowCount: 1,
      };
    }
    if (/count_user_sessions/.test(s)) {
      return { rows: [{ n: state.liveSessions }], command: "SELECT", rowCount: 1 };
    }
    if (/INSERT INTO public\.audit_log/.test(s)) {
      audits.push({
        babyId: (params[0] as string | null) ?? null,
        actorUserId: (params[1] as string | null) ?? null,
        event: String(params[3]),
        metadata: JSON.parse(String(params[4] ?? "{}")) as Record<string, unknown>,
      });
      return { rows: [], command: "INSERT", rowCount: 1 };
    }
    return { rows: [], command: "SELECT", rowCount: 0 };
  }

  const client = {
    query,
    release: () => undefined,
    on: () => client,
    off: () => client,
  } as unknown as pg.PoolClient;

  return Object.assign(db, {
    query,
    end: async () => undefined,
    connect: async () => client,
  }) as FakeDb;
}
