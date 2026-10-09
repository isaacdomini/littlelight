/**
 * In-house TypeScript row-type generator (docs/plans/step-2.md 2.10, R6). No dependency beyond
 * `pg`: reads pg_catalog for schema `public` and writes `src/generated/tables.ts` + `index.ts`.
 * Output is deterministic (sorted by table, then column position) so CI can diff it.
 *
 *   DATABASE_URL=postgres://postgres:dev@localhost:5432/littlelight pnpm --filter @littlelight/db db:types
 *
 * Per table: `<PascalTable>Row` (every column; nullable → `T | null`) and `<PascalTable>Insert`
 * (NOT NULL without default → required; generated/identity-always columns omitted; the rest
 * optional). `text` columns with a `CHECK (col IN (...))` constraint become string-literal unions.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { knownSecrets, requireDatabaseUrl } from "./env.js";
import { describeError } from "./redact.js";

const { Client } = pg;

export const GENERATED_DIR = fileURLToPath(new URL("./generated", import.meta.url));
/** Tables that are tooling, not application data. */
const EXCLUDED_TABLES = new Set(["pgmigrations"]);

interface ColumnInfo {
  table: string;
  column: string;
  /** `format_type` output without modifiers, e.g. `timestamp with time zone`, `text[]`. */
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  /** `a`/`d` for identity columns, `s` for generated columns, `''` otherwise. */
  identity: string;
  generated: string;
}

interface CheckInfo {
  table: string;
  definition: string;
}

const COLUMNS_SQL = `
SELECT c.relname AS table,
       a.attname AS column,
       regexp_replace(pg_catalog.format_type(a.atttypid, NULL), '\\s*\\(.*\\)', '') AS type,
       a.attnotnull AS "notNull",
       a.atthasdef AS "hasDefault",
       a.attidentity::text AS identity,
       a.attgenerated::text AS generated
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum
`;

const CHECKS_SQL = `
SELECT c.relname AS table, pg_catalog.pg_get_constraintdef(k.oid) AS definition
FROM pg_catalog.pg_constraint k
JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND k.contype = 'c'
ORDER BY c.relname, k.conname
`;

/** Postgres type name (modifiers stripped) → TypeScript type. */
export function tsType(pgType: string): string {
  if (pgType.endsWith("[]")) {
    const inner = tsType(pgType.slice(0, -2));
    return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`;
  }
  switch (pgType) {
    case "uuid":
    case "text":
    case "citext":
    case "character varying":
    case "character":
    case "vector":
    case "halfvec":
    case "tsvector":
    case "bit":
    case "bit varying":
    case "interval":
    case "inet":
    case "time without time zone":
    case "time with time zone":
      return "string";
    case "smallint":
    case "integer":
    case "real":
    case "double precision":
      return "number";
    case "bigint":
    case "numeric":
    case "xid8":
      return "string";
    case "boolean":
      return "boolean";
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "date":
      return "Date";
    case "json":
    case "jsonb":
      return "unknown";
    case "bytea":
      return "Buffer";
    default:
      return "unknown";
  }
}

/** `CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))` → `{ column, values }`; otherwise null. */
export function parseEnumCheck(definition: string): { column: string; values: string[] } | null {
  const match = /^CHECK \(\((\w+) = ANY \(\(?ARRAY\[(.*)\]\)?(?:::text\[\])?\)\)\)$/.exec(
    definition,
  );
  if (!match) return null;
  const column = match[1];
  const body = match[2];
  if (column === undefined || body === undefined) return null;
  const values: string[] = [];
  for (const literal of body.matchAll(/'((?:[^']|'')*)'::(?:text|character varying)/g)) {
    const value = literal[1];
    if (value !== undefined) values.push(value.replace(/''/g, "'"));
  }
  return values.length > 0 ? { column, values } : null;
}

export function pascalCase(name: string): string {
  return name
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Biome's line width; longer union members are wrapped exactly as the formatter would. */
const LINE_WIDTH = 100;

function literalUnion(values: readonly string[]): string {
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

/** One interface member, formatted the way `biome format` prints it (so CI diffs stay empty). */
function member(name: string, optional: boolean, type: string, nullable: boolean): string {
  const suffix = nullable ? " | null" : "";
  const single = `  ${name}${optional ? "?" : ""}: ${type}${suffix};`;
  if (single.length <= LINE_WIDTH || !type.includes(" | ")) return single;
  const parts = [...type.split(" | "), ...(nullable ? ["null"] : [])];
  return [`  ${name}${optional ? "?" : ""}:`, ...parts.map((part) => `    | ${part}`)]
    .join("\n")
    .concat(";");
}

export function renderTables(columns: readonly ColumnInfo[], checks: readonly CheckInfo[]): string {
  const enums = new Map<string, string[]>();
  for (const check of checks) {
    const parsed = parseEnumCheck(check.definition);
    if (parsed) enums.set(`${check.table}.${parsed.column}`, parsed.values);
  }

  const byTable = new Map<string, ColumnInfo[]>();
  for (const col of columns) {
    if (EXCLUDED_TABLES.has(col.table)) continue;
    const list = byTable.get(col.table) ?? [];
    list.push(col);
    byTable.set(col.table, list);
  }
  const tables = [...byTable.keys()].sort();

  const out: string[] = [
    "// Generated by `pnpm --filter @littlelight/db db:types` from the migrated database.",
    "// Do not edit by hand; CI fails when this file is out of date.",
    "",
  ];

  for (const table of tables) {
    const cols = byTable.get(table) ?? [];
    const pascal = pascalCase(table);
    out.push(`export interface ${pascal}Row {`);
    for (const col of cols) {
      const base = enums.get(`${table}.${col.column}`);
      const type = base ? literalUnion(base) : tsType(col.type);
      out.push(member(col.column, false, type, !col.notNull));
    }
    out.push("}", "");

    out.push(`export interface ${pascal}Insert {`);
    for (const col of cols) {
      if (col.generated === "s" || col.identity === "a") continue;
      const base = enums.get(`${table}.${col.column}`);
      const type = base ? literalUnion(base) : tsType(col.type);
      const required = col.notNull && !col.hasDefault && col.identity === "";
      out.push(member(col.column, !required, type, !col.notNull));
    }
    out.push("}", "");
  }

  out.push("export interface Tables {");
  for (const table of tables) {
    const pascal = pascalCase(table);
    out.push(`  ${table}: { row: ${pascal}Row; insert: ${pascal}Insert };`);
  }
  out.push("}", "");
  out.push("export type TableName = keyof Tables;", "");
  out.push("export const TABLE_NAMES = [");
  for (const table of tables) out.push(`  ${JSON.stringify(table)},`);
  out.push("] as const satisfies readonly TableName[];", "");
  return out.join("\n");
}

const INDEX_TS = `// Generated by \`pnpm --filter @littlelight/db db:types\`. Do not edit by hand.
export * from "./tables.js";
`;

export async function generateTypes(databaseUrl: string): Promise<{ tables: number }> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "littlelight-gen-types",
  });
  await client.connect();
  try {
    const columns = (await client.query<ColumnInfo>(COLUMNS_SQL)).rows;
    const checks = (await client.query<CheckInfo>(CHECKS_SQL)).rows;
    const source = renderTables(columns, checks);
    mkdirSync(GENERATED_DIR, { recursive: true });
    writeFileSync(join(GENERATED_DIR, "tables.ts"), source);
    writeFileSync(join(GENERATED_DIR, "index.ts"), INDEX_TS);
    const tables = new Set(columns.map((c) => c.table).filter((t) => !EXCLUDED_TABLES.has(t)));
    return { tables: tables.size };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  generateTypes(requireDatabaseUrl())
    .then(({ tables }) => {
      console.log(`db:types: wrote ${tables} table types to ${dirname(join(GENERATED_DIR, "x"))}`);
    })
    .catch((err: unknown) => {
      console.error(describeError(err, knownSecrets()));
      process.exit(1);
    });
}
