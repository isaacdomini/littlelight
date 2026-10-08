/**
 * node-pg-migrate programmatic runner over the plain-SQL files in `../migrations`
 * (docs/plans/step-1.md 2.7). Tracked in `public.pgmigrations`.
 *
 * CLI (via package scripts):
 *   tsx src/migrate.ts up [count]      — bootstrap (roles/auth schema) then apply pending migrations
 *   tsx src/migrate.ts down [count]    — revert `count` migrations (default 1; `all` reverts everything)
 *
 * Programmatic use (integration tests): `runMigrations({ direction, count, databaseUrl, bootstrap })`.
 */

import { fileURLToPath } from "node:url";
import { type RunnerOption, runner } from "node-pg-migrate";
import { bootstrapFromEnv } from "./bootstrap.js";
import { requireDatabaseUrl } from "./env.js";
import { describeError } from "./redact.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
export const MIGRATIONS_TABLE = "pgmigrations";

export type MigrationDirection = "up" | "down";

export interface RunMigrationsOptions {
  direction: MigrationDirection;
  /** Number of migrations to run. Default: all pending for `up`, 1 for `down`. */
  count?: number;
  databaseUrl?: string;
  /** Run the GoTrue role/schema bootstrap before migrating. Default: true for `up`, false for `down`. */
  bootstrap?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Defaults to console; receives already-redacted lines only. */
  log?: (line: string) => void;
}

export interface AppliedMigration {
  name: string;
}

/** Quiet logger: node-pg-migrate's default is verbose and echoes every statement. */
function makeLogger(log: (line: string) => void): NonNullable<RunnerOption["logger"]> {
  return {
    debug: () => undefined,
    info: (msg: string) => log(`migrate: ${msg}`),
    warn: (msg: string) => log(`migrate: warn: ${msg}`),
    error: (msg: string) => log(`migrate: error: ${msg}`),
  };
}

export async function runMigrations(options: RunMigrationsOptions): Promise<AppliedMigration[]> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl(env);
  const direction = options.direction;
  const count = options.count ?? (direction === "up" ? Number.POSITIVE_INFINITY : 1);
  const shouldBootstrap = options.bootstrap ?? direction === "up";

  if (shouldBootstrap) {
    await bootstrapFromEnv(env);
  }

  const applied = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction,
    count,
    checkOrder: true,
    singleTransaction: true,
    verbose: false,
    logger: makeLogger(log),
  });

  if (applied.length === 0) {
    log(`migrate: ${direction}: nothing to do`);
  } else {
    log(`migrate: ${direction}: applied ${applied.length} migration(s)`);
  }
  return applied.map((m) => ({ name: m.name }));
}

function parseCount(raw: string | undefined, direction: MigrationDirection): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === "all") return Number.POSITIVE_INFINITY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`usage: migrate ${direction} [count|all] — count must be a positive integer`);
  }
  return n;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, rawCount] = argv;
  if (command !== "up" && command !== "down") {
    throw new Error("usage: migrate <up|down> [count|all]");
  }
  await runMigrations({ direction: command, count: parseCount(rawCount, command) });
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main().catch((err: unknown) => {
    console.error(describeError(err, [process.env.AUTH_DB_PASSWORD ?? ""]));
    process.exit(1);
  });
}
