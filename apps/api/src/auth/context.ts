import {
  type AuditEvent,
  type AuditMetadata,
  type AuthenticatedClaims,
  auditEventSchema,
  auditMetadataSchema,
  type ClientKind,
  claimsToSql,
  FRESH_SIGN_IN_MAX_AGE_MIN,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "@tinyglow/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { ApiError, accountSuspended } from "../lib/errors";
import { runAs } from "../plugins/db";

// Request-scoped identity for database work (docs/plans/step-3.md 2.2 "Liveness", 2.7;
// packages/db/README.md "Per-transaction identity", "Session functions"). Every unit of work
// runs through `runAs` (BEGIN; SET LOCAL ROLE …; set_config('request.jwt.claims', $1, true);
// … COMMIT; RESET ROLE; DISCARD ALL). `withClaims` additionally starts with
// `auth_session_info(session_id)`: no row means GoTrue deleted the session (sign-out on another
// device, refresh-token reuse, account deletion) and the request fails with 401
// `session_revoked` even though the JWT is still within its hour; a suspended account (step 11)
// fails with 403 `account_suspended`.

/** What the auth hook establishes for a request carrying a valid user token. */
export interface AuthContext {
  claims: AuthenticatedClaims;
  /** `claims.sub`. */
  uid: string;
  email: string | null;
  /** The raw access token (needed for GoTrue `/logout`). Never log it. */
  token: string;
  transport: "cookie" | "bearer";
  clientKind: ClientKind;
  /** `claims.session_id`: the GoTrue `auth.sessions` row this token belongs to. */
  sessionId: string;
}

/** Facts available inside a `withClaims` transaction after the liveness check passed. */
export interface TxContext {
  uid: string;
  email: string | null;
  sessionId: string;
  /** `auth.sessions.created_at`: basis of "fresh sign-in". */
  sessionCreatedAt: Date;
  /** Session created at most `FRESH_SIGN_IN_MAX_AGE_MIN` minutes ago. */
  isFresh: boolean;
}

export type Tx = pg.PoolClient;

export const sessionRevoked = () =>
  new ApiError(401, "session_revoked", "You were signed out on this device");

export function isFreshSignIn(sessionCreatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - sessionCreatedAt.getTime() <= FRESH_SIGN_IN_MAX_AGE_MIN * 60_000;
}

/**
 * The `claims` → `TxContext` step, shared by `withClaims` and `withClaimsOf`. Step 11 (D13): a
 * suspended account (`profiles.suspended_at`, set by `admin:suspend`) fails every request with
 * 403 `account_suspended`, whether its session is still alive or was deleted by the tool.
 */
async function sessionLiveness(client: Tx, claims: AuthenticatedClaims): Promise<TxContext> {
  const { rows } = await client.query<{ created_at: Date; suspended: boolean }>(
    "SELECT created_at, suspended FROM public.auth_session_info($1)",
    [claims.session_id],
  );
  const row = rows[0];
  if (!row) {
    // `admin:suspend` deletes every session of the account, so a suspended user's still-valid
    // access token lands here; tell them why (own row only: the profiles self-select policy).
    const own = await client.query<{ suspended: boolean }>(
      "SELECT suspended_at IS NOT NULL AS suspended FROM public.profiles WHERE user_id = $1",
      [claims.sub],
    );
    if (own.rows[0]?.suspended) throw accountSuspended();
    throw sessionRevoked();
  }
  if (row.suspended) throw accountSuspended();
  return {
    uid: claims.sub,
    email: claims.email ?? null,
    sessionId: claims.session_id,
    sessionCreatedAt: row.created_at,
    isFresh: isFreshSignIn(row.created_at),
  };
}

/**
 * Run `fn` as `authenticated` under `claims`, after the session liveness check. Used by the
 * session-issuing routes (verify/refresh), where `request.auth` is not yet the new session, and
 * by anything else holding verified claims. Throws 401 `session_revoked` when the session is gone.
 */
export function withClaimsOf<T>(
  app: Pick<FastifyInstance, "db">,
  claims: AuthenticatedClaims,
  fn: (client: Tx, ctx: TxContext) => Promise<T>,
): Promise<T> {
  return runAs(app.db, "authenticated", { claimsJson: claimsToSql(claims) }, async (client) => {
    const ctx = await sessionLiveness(client, claims);
    return fn(client, ctx);
  });
}

/**
 * Run `fn` as the signed-in user of `request` (`request.auth`, set by the auth hook). Throws
 * 401 `unauthorized` without a valid token (so a route that forgot `requireAuth` still fails
 * closed) and 401 `session_revoked` when GoTrue no longer has the session.
 */
export function withClaims<T>(
  request: Pick<FastifyRequest, "auth" | "server">,
  fn: (client: Tx, ctx: TxContext) => Promise<T>,
): Promise<T> {
  const auth = request.auth;
  if (!auth) throw new ApiError(401, "unauthorized", "Sign in to continue");
  return withClaimsOf(request.server, auth.claims, fn);
}

export interface ServiceRoleOptions {
  /** Also bind `DATA_ENCRYPTION_KEY` as `app.data_key` (pgcrypto coordinate columns, step 5). */
  dataKey?: boolean;
}

/**
 * Run `fn` as `service_role` (BYPASSRLS). `reason` is mandatory and is the only thing logged
 * (at debug): it documents why a code path needs to bypass RLS. Bounded call sites in step 3:
 * invite lookup/accept by token hash, removal-request writes, account deletion.
 */
export function withServiceRole<T>(
  app: Pick<FastifyInstance, "db" | "log" | "config">,
  reason: string,
  fn: (client: Tx) => Promise<T>,
  opts: ServiceRoleOptions = {},
): Promise<T> {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("withServiceRole: a non-empty reason is required");
  }
  app.log.debug({ reason }, "service_role transaction");
  return runAs(
    app.db,
    "service_role",
    { dataKey: opts.dataKey ? app.config.DATA_ENCRYPTION_KEY : null },
    fn,
  );
}

/**
 * 403 `consent_required` unless the profile has accepted the current Terms and Privacy
 * versions. Reads `profiles` under the transaction's role (the user's own row).
 */
export async function requireConsent(client: Tx, ctx: Pick<TxContext, "uid">): Promise<void> {
  const { rows } = await client.query<{
    terms_version: string | null;
    privacy_version: string | null;
  }>("SELECT terms_version, privacy_version FROM public.profiles WHERE user_id = $1", [ctx.uid]);
  const row = rows[0];
  if (!row || row.terms_version !== TERMS_VERSION || row.privacy_version !== PRIVACY_VERSION) {
    throw new ApiError(403, "consent_required", "Accept the Terms and Privacy Policy to continue");
  }
}

/** 403 `fresh_sign_in_required` unless the session was created in the last 10 minutes. */
export function requireFreshSignIn(ctx: Pick<TxContext, "isFresh">): void {
  if (!ctx.isFresh) {
    throw new ApiError(403, "fresh_sign_in_required", "Please verify your email again to continue");
  }
}

export interface AuditInput {
  babyId?: string | null;
  /** The acting user; under `authenticated` the RLS policy requires it to equal `auth_uid()`. */
  actorUserId: string | null;
  shareLinkId?: string | null;
  /** Validated against `auditMetadataSchema` (strict): never emails, IPs, tokens, GPS, notes. */
  metadata?: AuditMetadata;
}

/** Append an `audit_log` row inside the current transaction. Metadata is schema-checked. */
export async function audit(client: Tx, event: AuditEvent, input: AuditInput): Promise<void> {
  const ev = auditEventSchema.parse(event);
  const metadata = auditMetadataSchema.parse(input.metadata ?? {});
  await client.query(
    "INSERT INTO public.audit_log (baby_id, actor_user_id, share_link_id, event, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      input.babyId ?? null,
      input.actorUserId,
      input.shareLinkId ?? null,
      ev,
      JSON.stringify(metadata),
    ],
  );
}
