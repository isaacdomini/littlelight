/**
 * Minimal env parsing for the db scripts. `@tinyglow/db` has no zod dependency on purpose: the
 * migrate image stays tiny and the scripts must fail with field names only, never values.
 */

const PRODUCTION_MIN_PASSWORD_LENGTH = 16;
/** `DATA_ENCRYPTION_KEY` minimum, same as `encryptionEnvSchema` in `@tinyglow/shared`. */
export const MIN_DATA_ENCRYPTION_KEY_LENGTH = 32;

export function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

/** `DATABASE_URL` is required for every script that touches Postgres. */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    // Mention only the field, never the value.
    throw new Error("DATABASE_URL must be a postgres:// URL");
  }
  return url;
}

/**
 * Shared rule for every database-role password: present, and at least 16 characters when
 * NODE_ENV=production (`openssl rand -hex 32`). Dev uses the literal `dev` so the zero-setup
 * stack keeps working. Error messages name the variable only, never the value.
 */
function requirePassword(env: NodeJS.ProcessEnv, name: string): string {
  const password = env[name];
  if (password === undefined || password.length === 0) {
    throw new Error(`${name} is not set`);
  }
  if (isProduction(env) && password.length < PRODUCTION_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `${name} must be at least ${PRODUCTION_MIN_PASSWORD_LENGTH} characters when NODE_ENV=production`,
    );
  }
  return password;
}

/** `AUTH_DB_PASSWORD`: login password of `supabase_auth_admin` (GoTrue's DB user). */
export function requireAuthDbPassword(env: NodeJS.ProcessEnv = process.env): string {
  return requirePassword(env, "AUTH_DB_PASSWORD");
}

/** `API_DB_PASSWORD`: login password of `tinyglow_api` (the API's connection role). */
export function requireApiDbPassword(env: NodeJS.ProcessEnv = process.env): string {
  return requirePassword(env, "API_DB_PASSWORD");
}

/** `WORKER_DB_PASSWORD`: login password of `tinyglow_worker` (the worker's connection role). */
export function requireWorkerDbPassword(env: NodeJS.ProcessEnv = process.env): string {
  return requirePassword(env, "WORKER_DB_PASSWORD");
}

/**
 * `DATA_ENCRYPTION_KEY`: pgcrypto key for GPS / home coordinates (docs/plans/step-2.md 2.7).
 * At least 32 characters in every environment. Reaches SQL only as a bind parameter to
 * `set_config('app.data_key', $1, true)`; never interpolated, never logged.
 */
export function requireDataEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.DATA_ENCRYPTION_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error("DATA_ENCRYPTION_KEY is not set");
  }
  if (key.length < MIN_DATA_ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `DATA_ENCRYPTION_KEY must be at least ${MIN_DATA_ENCRYPTION_KEY_LENGTH} characters`,
    );
  }
  return key;
}

/**
 * Demo-family seed gate (docs/plans/step-2.md 2.9).
 * - `"skip"`: `SEED_DEMO_FAMILY` is not `true` → the seed exits 0 doing nothing.
 * - `"refuse"`: the flag is set but NODE_ENV=production → the seed exits 1 doing nothing.
 * - `"run"`: dev/test with the flag set.
 */
export type SeedMode = "skip" | "refuse" | "run";

export function seedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  if (env.SEED_DEMO_FAMILY !== "true") return "skip";
  return isProduction(env) ? "refuse" : "run";
}

/** True only when the demo seed should actually write rows. */
export function seedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return seedMode(env) === "run";
}

/** Every secret the db scripts know about, for `describeError` redaction (empty ones are ignored). */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.AUTH_DB_PASSWORD ?? "",
    env.API_DB_PASSWORD ?? "",
    env.WORKER_DB_PASSWORD ?? "",
    env.DATA_ENCRYPTION_KEY ?? "",
  ];
}
