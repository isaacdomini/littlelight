/**
 * Minimal env parsing for the db scripts. `@littlelight/db` has no zod dependency on purpose: the
 * migrate image stays tiny and the scripts must fail with field names only, never values.
 */

const PRODUCTION_MIN_PASSWORD_LENGTH = 16;

function isProduction(env: NodeJS.ProcessEnv): boolean {
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
 * `AUTH_DB_PASSWORD` is the login password of `supabase_auth_admin` (GoTrue's DB user). Dev uses
 * the literal `dev` from `.env.dev`; production must supply a generated secret
 * (`openssl rand -base64 48`). The length check only applies when NODE_ENV=production so the
 * zero-setup dev stack keeps working.
 */
export function requireAuthDbPassword(env: NodeJS.ProcessEnv = process.env): string {
  const password = env.AUTH_DB_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error("AUTH_DB_PASSWORD is not set");
  }
  if (isProduction(env) && password.length < PRODUCTION_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `AUTH_DB_PASSWORD must be at least ${PRODUCTION_MIN_PASSWORD_LENGTH} characters when NODE_ENV=production`,
    );
  }
  return password;
}
