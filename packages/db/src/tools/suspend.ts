/**
 * Operator account suspension (docs/plans/step-11.md 2.2 E, 2.6, D13):
 *
 *   pnpm admin:suspend <userId> [--reason abuse|other] [--i-know-this-is-production]
 *   pnpm admin:suspend <userId> --lift [--i-know-this-is-production]
 *   docker compose run --rm migrate pnpm admin:suspend <userId> --i-know-this-is-production
 *
 * Runs with the superuser `DATABASE_URL` (same as migrate/seed/db:plan) in one transaction:
 * - suspend: `profiles.suspended_at = now()` (kept if already set) and `suspended_reason`
 *   (default `abuse`); every `auth.sessions` row of the user is deleted (GoTrue cascades the
 *   refresh tokens), so every device is out at once; `audit_log` `account.suspended`
 *   (`actor_user_id` NULL, metadata `{target_user_id, reason}`) unless it was already suspended
 *   for the same reason. From then on the api answers 403 `account_suspended` to every request
 *   (`auth_session_info.suspended`), refuses sign-in and sends no sign-in codes.
 * - `--lift`: clears both columns and writes `account.unsuspended` (`{target_user_id}`) when the
 *   account was suspended; sessions are not touched (there are none).
 * Refuses a user with no profile (unknown, or never signed in) and an account being deleted.
 * Albums, members and share links are not touched. Refuses with `NODE_ENV=production` unless
 * `--i-know-this-is-production` is passed (the migrate image always runs with
 * `NODE_ENV=production` unless the environment overrides it, as dev Compose does).
 *
 * The migrate image contains only this package (pg, node-pg-migrate, tsx): nothing here may
 * import another workspace package. Output names ids, the reason and counts only; never an email
 * (errors go through `redact.ts`).
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import { isProduction, knownSecrets, requireDatabaseUrl } from "../env.js";
import { describeError } from "../redact.js";

const { Client } = pg;

/** `profiles.suspended_reason` values (mirror of `SUSPENSION_REASONS` in `@tinyglow/shared`). */
export const SUSPENSION_REASONS = ["abuse", "other"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export const PRODUCTION_FLAG = "--i-know-this-is-production";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE =
  "usage: admin:suspend <userId> [--lift] [--reason abuse|other] [--i-know-this-is-production]";

export interface SuspendArgs {
  userId: string;
  lift: boolean;
  /** `null` with `--lift`; else the reason (default `abuse`). */
  reason: SuspensionReason | null;
  allowProduction: boolean;
}

/** Thrown for bad arguments (exit 2) as opposed to a refused or failed change (exit 1). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Parse `argv` (without the node/script entries). A leading literal `--` is ignored. */
export function parseSuspendArgs(argv: readonly string[]): SuspendArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let userId: string | undefined;
  let lift = false;
  let reason: SuspensionReason | undefined;
  let allowProduction = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === PRODUCTION_FLAG) {
      allowProduction = true;
    } else if (arg === "--lift") {
      lift = true;
    } else if (arg === "--reason") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--reason needs a value\n${USAGE}`);
      }
      i += 1;
      if (!(SUSPENSION_REASONS as readonly string[]).includes(value)) {
        throw new UsageError(`--reason must be one of ${SUSPENSION_REASONS.join("|")}`);
      }
      reason = value as SuspensionReason;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg}\n${USAGE}`);
    } else if (userId === undefined) {
      if (!UUID_RE.test(arg)) throw new UsageError(`userId must be a uuid\n${USAGE}`);
      userId = arg.toLowerCase();
    } else {
      throw new UsageError(`unexpected argument\n${USAGE}`);
    }
  }
  if (userId === undefined) throw new UsageError(USAGE);
  if (lift && reason !== undefined) throw new UsageError("--reason does not apply to --lift");
  return { userId, lift, reason: lift ? null : (reason ?? "abuse"), allowProduction };
}

export interface SuspendOptions {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  /** Receives already-redacted lines only. */
  log?: (line: string) => void;
}

export interface SuspendResult {
  userId: string;
  /** State after the change. */
  suspended: boolean;
  /** False when the account was already in the requested state, same reason (no audit row). */
  changed: boolean;
  reason: SuspensionReason | null;
  /** `auth.sessions` rows deleted (suspend only). */
  sessionsEnded: number;
  /** `audit_log.id`, or `null` when nothing changed. */
  auditId: string | null;
}

/** Apply the suspension or lift it. Throws (after ROLLBACK) for an unknown or deleted account. */
export async function suspendAccount(
  args: SuspendArgs,
  options: SuspendOptions = {},
): Promise<SuspendResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  if (isProduction(env) && !args.allowProduction) {
    throw new Error(
      `refusing to ${args.lift ? "lift a suspension" : "suspend an account"} with NODE_ENV=production; pass ${PRODUCTION_FLAG} to confirm`,
    );
  }
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl(env);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "tinyglow-admin-suspend",
  });
  try {
    await client.connect();
    await client.query("BEGIN");

    const found = await client.query<{
      suspended_at: Date | null;
      suspended_reason: SuspensionReason | null;
      deleted_at: Date | null;
    }>(
      "SELECT suspended_at, suspended_reason, deleted_at FROM public.profiles WHERE user_id = $1 FOR UPDATE",
      [args.userId],
    );
    const profile = found.rows[0];
    if (profile === undefined) {
      throw new Error(`user ${args.userId} has no profile (unknown, or never signed in)`);
    }
    if (profile.deleted_at !== null) {
      throw new Error(`user ${args.userId} is being deleted; nothing to suspend`);
    }
    const wasSuspended = profile.suspended_at !== null;
    // Suspending again with another reason is a change too (audited); same reason is a no-op.
    const changed = args.lift
      ? wasSuspended
      : !wasSuspended || profile.suspended_reason !== args.reason;

    let sessionsEnded = 0;
    let auditId: string | null = null;
    if (args.lift) {
      if (changed) {
        await client.query(
          "UPDATE public.profiles SET suspended_at = NULL, suspended_reason = NULL WHERE user_id = $1",
          [args.userId],
        );
        auditId = await auditRow(client, "account.unsuspended", { target_user_id: args.userId });
      }
    } else {
      await client.query(
        `UPDATE public.profiles
            SET suspended_at = COALESCE(suspended_at, now()), suspended_reason = $2
          WHERE user_id = $1 AND deleted_at IS NULL`,
        [args.userId, args.reason],
      );
      // Every device out now (refresh tokens cascade with their session); the api's liveness
      // check would refuse the remaining access tokens anyway.
      const ended = await client.query("DELETE FROM auth.sessions WHERE user_id = $1", [
        args.userId,
      ]);
      sessionsEnded = ended.rowCount ?? 0;
      if (changed) {
        auditId = await auditRow(client, "account.suspended", {
          target_user_id: args.userId,
          reason: args.reason ?? "abuse",
        });
      }
    }

    await client.query("COMMIT");

    if (args.lift) {
      log(
        changed
          ? `admin:suspend: user ${args.userId} suspension lifted; audit_log ${auditId}`
          : `admin:suspend: user ${args.userId} was not suspended; nothing changed`,
      );
    } else {
      log(
        changed
          ? `admin:suspend: user ${args.userId} suspended (reason ${args.reason}); ${sessionsEnded} session(s) ended; audit_log ${auditId}`
          : `admin:suspend: user ${args.userId} was already suspended (reason ${args.reason}); ${sessionsEnded} session(s) ended`,
      );
    }
    return {
      userId: args.userId,
      suspended: !args.lift,
      changed,
      reason: args.lift ? null : args.reason,
      sessionsEnded,
      auditId,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the original error is what matters
    }
    throw new Error(`admin:suspend failed: ${describeError(err, knownSecrets(env))}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function auditRow(
  client: pg.Client,
  event: "account.suspended" | "account.unsuspended",
  metadata: Record<string, string>,
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO public.audit_log (baby_id, actor_user_id, event, metadata)
     VALUES (NULL, NULL, $1, $2::jsonb) RETURNING id`,
    [event, JSON.stringify(metadata)],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error("audit_log insert returned no id");
  return id;
}

/** CLI entry. Exit codes: 0 done, 1 refused/failed, 2 usage. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let args: SuspendArgs;
  try {
    args = parseSuspendArgs(argv);
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 2;
  }
  try {
    await suspendAccount(args, { env, log });
    return 0;
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main().then((code) => process.exit(code));
}
