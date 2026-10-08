import type pg from "pg";
import type { WorkerLog } from "../log-types";
import type { ObjectStorage } from "../storage";

// Unit-test doubles for the worker: a recording logger, a scripted pipeline pool and an
// in-memory object store. Test-only.

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

export function recordingLog(): WorkerLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const mk = (level: LogLine["level"]) => (obj: object, msg: string) => {
    lines.push({ level, obj: obj as Record<string, unknown>, msg });
  };
  return { lines, debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") };
}

export interface QueryResult {
  rows?: unknown[];
  rowCount?: number | null;
  command?: string;
}

export type Handler = (params: unknown[]) => QueryResult | Promise<QueryResult>;

export interface ScriptedPool {
  connect(): Promise<pg.PoolClient>;
  /** Every statement in order: [sql, params]. */
  log: [string, unknown[] | undefined][];
  /** Statements run on application tables (BEGIN/COMMIT/role plumbing filtered out). */
  appQueries(): [string, unknown[] | undefined][];
  clients: ScriptedClient[];
}

export interface ScriptedClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<Required<Pick<QueryResult, "rows">> & QueryResult>;
  on(ev: string, fn: (...a: unknown[]) => void): ScriptedClient;
  off(ev: string): ScriptedClient;
  release(err?: Error): void;
  released: { err?: Error } | null;
  emit(ev: string, ...args: unknown[]): void;
}

const PLUMBING = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE|RESET ROLE|DISCARD ALL|SELECT set_config)/;

/**
 * A pool whose clients answer by exact SQL text (the worker exports its statements as consts):
 * `handlers.get(SQL)` gets the bind params. Unknown statements return no rows. Transaction
 * plumbing is answered with `COMMIT` command info and recorded.
 */
export function scriptedPool(
  handlers: Map<string, Handler> | Record<string, Handler> = new Map(),
): ScriptedPool {
  const map = handlers instanceof Map ? handlers : new Map(Object.entries(handlers));
  const log: ScriptedPool["log"] = [];
  const clients: ScriptedClient[] = [];
  const pool: ScriptedPool = {
    log,
    clients,
    appQueries: () => log.filter(([sql]) => !PLUMBING.test(sql)),
    async connect() {
      const listeners = new Map<string, (...a: unknown[]) => void>();
      const client: ScriptedClient = {
        released: null,
        async query(sql, params) {
          log.push([sql, params]);
          if (PLUMBING.test(sql)) return { rows: [], command: sql.split(" ")[0] };
          const h = map.get(sql);
          const res = h ? await h(params ?? []) : {};
          return { rows: res.rows ?? [], rowCount: res.rowCount ?? res.rows?.length ?? 0, ...res };
        },
        on(ev, fn) {
          listeners.set(ev, fn);
          return client;
        },
        off(ev) {
          listeners.delete(ev);
          return client;
        },
        release(err) {
          client.released = { err };
        },
        emit(ev, ...args) {
          listeners.get(ev)?.(...args);
        },
      };
      clients.push(client);
      return client as unknown as pg.PoolClient;
    },
  };
  return pool;
}

export interface MemoryStorage extends ObjectStorage {
  calls: string[];
  failOn: Set<string>;
}

/** In-memory ObjectStorage that records calls like `delete:<prefix>`; `failOn` makes a call throw. */
export function memoryStorage(
  opts: {
    deleteCounts?: Record<string, number>;
    multipart?: { key: string; uploadId: string; initiated: Date | null }[];
  } = {},
): MemoryStorage {
  const calls: string[] = [];
  const failOn = new Set<string>();
  const guard = (name: string) => {
    if (failOn.has(name)) throw new Error(`stub failure: ${name}`);
  };
  return {
    calls,
    failOn,
    async getObject(key) {
      calls.push(`get:${key}`);
      guard(`get:${key}`);
      return Buffer.alloc(0);
    },
    async putObject(key) {
      calls.push(`put:${key}`);
      guard(`put:${key}`);
    },
    async deleteAllVersions(prefix) {
      calls.push(`delete:${prefix}`);
      guard(`delete:${prefix}`);
      return opts.deleteCounts?.[prefix] ?? 1;
    },
    async listMultipartUploads(prefix) {
      calls.push(`list:${prefix}`);
      return opts.multipart ?? [];
    },
    async abortMultipartUpload(key, uploadId) {
      calls.push(`abort:${key}:${uploadId}`);
      guard(`abort:${key}:${uploadId}`);
    },
  };
}
