import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { audit, withServiceRole } from "../../auth";
import { googleImportSettings } from "../../config";
import { googleNotConnected, googleReconnect } from "../../lib/errors";
import { createGoogleClient, type GoogleClient, GoogleError, isGoogleError } from "./client";

// The Google connection of one user (`google_accounts`; docs/plans/step-10.md 2.2, 2.6, D6).
// The three bounded `service_role` uses of the import API live here (step-10 plan 10.8):
//   1. the connect callback writes the refresh token with `encrypt_secret` (`app.data_key`);
//   2. the token refresh path reads it with `decrypt_secret` (and the batch's Google session id,
//      which `authenticated` cannot select), and flags `needs_reconnect` after `invalid_grant`;
//   3. disconnect / account deletion read it to revoke at Google, then delete the row.
// Plaintext tokens live in local variables for one request only: never returned to a client,
// never logged, never put in an error.

declare module "fastify" {
  interface FastifyInstance {
    /** Google client of the configured provider; `null` when `GOOGLE_IMPORT_PROVIDER=none`. */
    googleImport: GoogleClient | null;
  }
}

type App = Pick<FastifyInstance, "db" | "log" | "config">;

/** The client on `app` (set by `importsRoutes`), else one built from the config. */
export function googleClientOf(
  app: Pick<FastifyInstance, "config"> & { googleImport?: GoogleClient | null },
) {
  if (app.googleImport !== undefined) return app.googleImport;
  return createGoogleClient(googleImportSettings(app.config));
}

export interface StoredCredentials {
  /** Plaintext refresh token: never log it. */
  refreshToken: string;
  needsReconnect: boolean;
  /** `import_batches.provider_session_id` of the requested batch (requester-bound), if any. */
  sessionId: string | null;
}

/**
 * service_role (data key bound): the user's decrypted refresh token and, when `batchId` is given,
 * the batch's Google session id — only for a batch this user requested. `null` when not connected.
 */
export async function loadCredentials(
  app: App,
  uid: string,
  batchId?: string,
): Promise<StoredCredentials | null> {
  return withServiceRole(
    app,
    "google import: decrypt the caller's refresh token",
    async (client) => {
      const { rows } = await client.query<{ token: string; needs_reconnect: boolean }>(
        `SELECT public.decrypt_secret(refresh_token_enc) AS token, needs_reconnect
           FROM public.google_accounts WHERE user_id = $1`,
        [uid],
      );
      const row = rows[0];
      if (!row) return null;
      let sessionId: string | null = null;
      if (batchId) {
        const s = await client.query<{ provider_session_id: string | null }>(
          `SELECT provider_session_id FROM public.import_batches
            WHERE id = $1 AND requested_by = $2`,
          [batchId, uid],
        );
        sessionId = s.rows[0]?.provider_session_id ?? null;
      }
      return { refreshToken: row.token, needsReconnect: row.needs_reconnect, sessionId };
    },
    { dataKey: true },
  );
}

/** service_role: Google answered `invalid_grant` for this user's refresh token. */
export async function markNeedsReconnect(app: App, uid: string): Promise<void> {
  await withServiceRole(app, "google import: flag a dead refresh token", (client) =>
    client.query(
      `UPDATE public.google_accounts
          SET needs_reconnect = true, refresh_failures = refresh_failures + 1
        WHERE user_id = $1`,
      [uid],
    ),
  );
}

/**
 * service_role (data key bound): store (or replace) the user's refresh token and audit
 * `import.google_connected`. A new connect clears `needs_reconnect` and the failure counter.
 */
export async function storeConnection(
  app: App,
  uid: string,
  refreshToken: string,
  scope: string,
): Promise<void> {
  await withServiceRole(
    app,
    "google import connect: encrypt and store the refresh token",
    async (client) => {
      await client.query(
        `INSERT INTO public.google_accounts (user_id, refresh_token_enc, scope)
         VALUES ($1, public.encrypt_secret($2), $3)
         ON CONFLICT (user_id) DO UPDATE
            SET refresh_token_enc = EXCLUDED.refresh_token_enc,
                scope = EXCLUDED.scope,
                connected_at = now(),
                last_used_at = NULL,
                needs_reconnect = false,
                refresh_failures = 0`,
        [uid, refreshToken, scope],
      );
      await audit(client, "import.google_connected", { actorUserId: uid });
    },
    { dataKey: true },
  );
}

/** service_role: remember when the connection was last used to mint an access token. */
async function touchConnection(app: App, uid: string): Promise<void> {
  await withServiceRole(app, "google import: record connection use", (client) =>
    client.query("UPDATE public.google_accounts SET last_used_at = now() WHERE user_id = $1", [
      uid,
    ]),
  );
}

export interface AccessGrant {
  /** In memory for this request only: never log, store or return it. */
  accessToken: string;
  sessionId: string | null;
}

/**
 * An access token for `uid` minted from the stored refresh token (and the batch's Google session
 * id when `batchId` is given). 409 `google_not_connected` / `google_reconnect`; Google's
 * `invalid_grant` flags the row first. Other Google failures surface as `GoogleError`.
 */
export async function mintAccessToken(
  app: App,
  google: GoogleClient,
  uid: string,
  batchId?: string,
): Promise<AccessGrant> {
  const creds = await loadCredentials(app, uid, batchId);
  if (!creds) throw googleNotConnected();
  if (creds.needsReconnect) throw googleReconnect();
  let accessToken: string;
  try {
    accessToken = await google.refreshAccessToken(creds.refreshToken);
  } catch (err) {
    if (isGoogleError(err) && err.category === "google_reconnect") {
      await markNeedsReconnect(app, uid);
      throw googleReconnect();
    }
    throw err;
  }
  await touchConnection(app, uid);
  return { accessToken, sessionId: creds.sessionId };
}

/**
 * Revoke the user's Google grant (best effort, 5 s) and delete the `google_accounts` row, under
 * service_role. Used by `DELETE /me/import/google/connection` and by account deletion (2.8, task
 * 10.10: call it before the GoTrue delete). Never throws; logs `{ revoked }` only. Returns whether
 * a row existed and whether Google confirmed the revocation.
 */
export async function revokeGoogleConnection(
  app: App & { googleImport?: GoogleClient | null },
  uid: string,
  log: Pick<FastifyBaseLogger, "info" | "warn"> = app.log,
): Promise<{ existed: boolean; revoked: boolean }> {
  let existed = false;
  let revoked = false;
  try {
    const creds = await loadCredentials(app, uid);
    existed = creds !== null;
    const google = googleClientOf(app);
    if (creds && google) revoked = await google.revoke(creds.refreshToken);
  } catch (err) {
    log.warn(
      { category: err instanceof GoogleError ? err.category : "internal" },
      "google connection: could not read the token to revoke",
    );
  }
  try {
    const { rowCount } = await withServiceRole(
      app,
      "google import disconnect: delete the connection",
      (client) => client.query("DELETE FROM public.google_accounts WHERE user_id = $1", [uid]),
    );
    existed = existed || (rowCount ?? 0) > 0;
  } catch {
    log.warn({ revoked }, "google connection: delete failed");
    return { existed, revoked };
  }
  if (existed) log.info({ revoked }, "google connection removed");
  return { existed, revoked };
}
