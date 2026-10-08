import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const sh = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");

/** Read-only superuser query through the dev stack's db container (`psql -Atc`). Rows by line. */
export async function psql(sql: string): Promise<string[]> {
  const { stdout } = await sh(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "littlelight",
      "-At",
      "-c",
      sql,
    ],
    { cwd: ROOT },
  );
  return stdout.split("\n").filter((l) => l.length > 0);
}
