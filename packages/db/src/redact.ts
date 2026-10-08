/**
 * Scrub secrets out of strings before they reach stdout/stderr or an error log.
 *
 * - Masks the password in any `scheme://user:password@host` URL (DATABASE_URL, GOTRUE_DB_DATABASE_URL).
 * - Masks every literal in `secrets` (e.g. AUTH_DB_PASSWORD) wherever it appears.
 *
 * Nothing in this package may print a connection string or a password un-redacted.
 */
export function redactSecrets(input: string, secrets: readonly string[] = []): string {
  let out = input.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, "$1***@");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/** Error → single-line redacted message (never the stack, which can embed query text). */
export function describeError(err: unknown, secrets: readonly string[] = []): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactSecrets(message, secrets);
}
