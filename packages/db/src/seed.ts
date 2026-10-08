/**
 * Seed script. Step 1: intentional no-op (docs/plans/step-1.md 2.7). Step 2 adds the demo family.
 * Must stay idempotent: running it any number of times yields the same database state.
 */

import { fileURLToPath } from "node:url";
import { describeError } from "./redact.js";

export interface SeedOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export async function seed(options: SeedOptions = {}): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  log("seed: nothing to seed yet");
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  seed().catch((err: unknown) => {
    console.error(describeError(err, [process.env.AUTH_DB_PASSWORD ?? ""]));
    process.exit(1);
  });
}
