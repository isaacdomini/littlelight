/**
 * Dev/operator plan setter (docs/plans/step-6.md 2.3.8, D7). Until billing webhooks exist this is
 * the only path that changes `babies.plan`:
 *
 *   pnpm db:plan <babyId> plus|free [--owner <userId>] [--expires <iso>] [--i-know-this-is-production]
 *   docker compose -f docker-compose.dev.yml run --rm migrate pnpm db:plan <babyId> plus
 *
 * Runs with the superuser `DATABASE_URL` (same as migrate/seed) in one transaction: refuses when
 * the baby does not exist (or is trashed), writes `plan`, `plan_owner_user_id` (NULL unless
 * `--owner`; a plus plan with no owner is the "manual grant" the step-3 `babies_plan_follows_owner`
 * trigger leaves alone) and `entitlement_expires_at`, then appends an `audit_log` row
 * `baby.plan_changed` (`actor_user_id` NULL, metadata `{plan}` plus `target_user_id` when an owner
 * was named). Refuses with `NODE_ENV=production` unless `--i-know-this-is-production` is passed.
 *
 * The migrate image contains only this package (pg, node-pg-migrate, tsx): nothing here may
 * import another workspace package. Output names ids and the plan only; never a baby's name,
 * a URL or a password (errors go through `redact.ts`).
 */

import { fileURLToPath } from "node:url";
import pg from "pg";
import { isProduction, knownSecrets, requireDatabaseUrl } from "../env.js";
import { describeError } from "../redact.js";

const { Client } = pg;

export const PLANS = ["free", "plus"] as const;
export type Plan = (typeof PLANS)[number];

export const PRODUCTION_FLAG = "--i-know-this-is-production";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE =
  "usage: db:plan <babyId> <plus|free> [--owner <userId>] [--expires <iso-date-time>] [--i-know-this-is-production]";

export interface SetPlanArgs {
  babyId: string;
  plan: Plan;
  /** `plan_owner_user_id`; must be an admin of the baby. Only meaningful with `plus`. */
  ownerUserId: string | null;
  /** `entitlement_expires_at`; only meaningful with `plus`. */
  expiresAt: Date | null;
  allowProduction: boolean;
}

/** Thrown for bad arguments (exit 2) as opposed to a refused or failed change (exit 1). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * Parse `argv` (without the node/script entries). A leading literal `--` is ignored (pnpm 12
 * forwards arguments without it, older invocations may still pass one).
 */
export function parseSetPlanArgs(argv: readonly string[]): SetPlanArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let babyId: string | undefined;
  let plan: Plan | undefined;
  let ownerUserId: string | null = null;
  let expiresAt: Date | null = null;
  let allowProduction = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === PRODUCTION_FLAG) {
      allowProduction = true;
    } else if (arg === "--owner" || arg === "--expires") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value\n${USAGE}`);
      }
      i += 1;
      if (arg === "--owner") {
        if (!UUID_RE.test(value)) throw new UsageError("--owner must be a user id (uuid)");
        ownerUserId = value.toLowerCase();
      } else {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw new UsageError("--expires must be an ISO date-time");
        }
        expiresAt = parsed;
      }
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg}\n${USAGE}`);
    } else if (babyId === undefined) {
      if (!UUID_RE.test(arg)) throw new UsageError(`babyId must be a uuid\n${USAGE}`);
      babyId = arg.toLowerCase();
    } else if (plan === undefined) {
      if (!(PLANS as readonly string[]).includes(arg)) {
        throw new UsageError(`plan must be one of ${PLANS.join("|")}\n${USAGE}`);
      }
      plan = arg as Plan;
    } else {
      throw new UsageError(`unexpected argument\n${USAGE}`);
    }
  }
  if (babyId === undefined || plan === undefined) throw new UsageError(USAGE);
  if (plan === "free" && (ownerUserId !== null || expiresAt !== null)) {
    throw new UsageError("--owner and --expires only apply to the plus plan");
  }
  return { babyId, plan, ownerUserId, expiresAt, allowProduction };
}

export interface SetPlanOptions {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  /** Receives already-redacted lines only. */
  log?: (line: string) => void;
}

export interface SetPlanResult {
  babyId: string;
  previousPlan: Plan;
  plan: Plan;
  ownerUserId: string | null;
  expiresAt: Date | null;
  /** `audit_log.id` of the `baby.plan_changed` row. */
  auditId: string;
}

/** Hint printed after an upgrade (FR-5.8: one backfill batch for existing photos). */
export function backfillHint(babyId: string): string {
  return `pnpm --filter @littlelight/worker run-job --enqueue ai.backfill '{"babyId":"${babyId}","reason":"upgrade"}'`;
}

/**
 * Hint printed after an upgrade (docs/plans/step-7.md 2.7): the search index follows the plan.
 * The `ai.backfill` upgrade job chains `search.backfill` itself once it completes; this line
 * indexes the baby's photos right away (documents without AI descriptions are refreshed again
 * when the descriptions land).
 */
export function searchBackfillHint(babyId: string): string {
  return `pnpm --filter @littlelight/worker run-job --enqueue search.backfill '{"babyId":"${babyId}","reason":"upgrade"}'`;
}

/**
 * Apply the plan change. Throws (after ROLLBACK) when the baby is missing/trashed, when the
 * owner is not an admin of the baby, or when the resulting row does not carry the requested plan.
 */
export async function setPlan(
  args: SetPlanArgs,
  options: SetPlanOptions = {},
): Promise<SetPlanResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  if (isProduction(env) && !args.allowProduction) {
    throw new Error(
      `refusing to change a plan with NODE_ENV=production (billing owns plans there); pass ${PRODUCTION_FLAG} for an operator override`,
    );
  }
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl(env);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "littlelight-set-plan",
  });
  try {
    await client.connect();
    await client.query("BEGIN");

    const baby = await client.query<{ plan: Plan }>(
      "SELECT plan FROM public.babies WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [args.babyId],
    );
    const previousPlan = baby.rows[0]?.plan;
    if (previousPlan === undefined) {
      throw new Error(`baby ${args.babyId} does not exist (or is trashed)`);
    }
    if (args.ownerUserId !== null) {
      const admin = await client.query(
        "SELECT 1 FROM public.baby_members WHERE baby_id = $1 AND user_id = $2 AND role = 'admin'",
        [args.babyId, args.ownerUserId],
      );
      if (admin.rowCount === 0) {
        throw new Error(`--owner ${args.ownerUserId} is not an admin of baby ${args.babyId}`);
      }
    }

    // Two steps on purpose: `babies_plan_follows_owner` (step 3) turns a plus plan into free
    // whenever plan_owner_user_id goes from set to NULL in the same UPDATE. Releasing the old
    // owner on a free row first makes the second UPDATE a NULL -> NULL/owner transition, which the
    // trigger leaves alone, so `plus` with no --owner is the documented manual grant.
    await client.query(
      "UPDATE public.babies SET plan = 'free', plan_owner_user_id = NULL, entitlement_expires_at = NULL WHERE id = $1",
      [args.babyId],
    );
    const updated = await client.query<{
      plan: Plan;
      plan_owner_user_id: string | null;
      entitlement_expires_at: Date | null;
    }>(
      `UPDATE public.babies SET plan = $2, plan_owner_user_id = $3, entitlement_expires_at = $4
       WHERE id = $1 RETURNING plan, plan_owner_user_id, entitlement_expires_at`,
      [args.babyId, args.plan, args.ownerUserId, args.expiresAt],
    );
    const row = updated.rows[0];
    if (!row || row.plan !== args.plan) {
      throw new Error(`plan change for baby ${args.babyId} did not persist as ${args.plan}`);
    }

    const metadata: Record<string, string> = { plan: args.plan };
    if (args.ownerUserId !== null) metadata.target_user_id = args.ownerUserId;
    const audit = await client.query<{ id: string }>(
      `INSERT INTO public.audit_log (baby_id, actor_user_id, event, metadata)
       VALUES ($1, NULL, 'baby.plan_changed', $2::jsonb) RETURNING id`,
      [args.babyId, JSON.stringify(metadata)],
    );
    const auditId = audit.rows[0]?.id;
    if (auditId === undefined) throw new Error("audit_log insert returned no id");

    await client.query("COMMIT");

    const owner = row.plan_owner_user_id ?? "none";
    const expires = row.entitlement_expires_at ? row.entitlement_expires_at.toISOString() : "never";
    log(
      `db:plan: baby ${args.babyId} plan ${previousPlan} -> ${row.plan} (owner: ${owner}, expires: ${expires}); audit_log ${auditId}`,
    );
    if (args.plan === "plus") {
      log(
        "db:plan: AI eligibility is on; the regular flush describes existing photos within one batch window, or enqueue the backfill now:",
      );
      log(`  ${backfillHint(args.babyId)}`);
      log("db:plan: search follows the AI backfill automatically; to index the photos now:");
      log(`  ${searchBackfillHint(args.babyId)}`);
    } else {
      log(
        "db:plan: AI, search and chat are off for this baby (baby_ai_enabled = false); existing photo_ai rows stay but no photo can enter a batch.",
      );
    }
    return {
      babyId: args.babyId,
      previousPlan,
      plan: row.plan,
      ownerUserId: row.plan_owner_user_id,
      expiresAt: row.entitlement_expires_at,
      auditId,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be gone; the original error is what matters
    }
    throw new Error(`db:plan failed: ${describeError(err, knownSecrets(env))}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** CLI entry. Exit codes: 0 done, 1 refused/failed, 2 usage. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let args: SetPlanArgs;
  try {
    args = parseSetPlanArgs(argv);
  } catch (err) {
    console.error(describeError(err, knownSecrets(env)));
    return 2;
  }
  try {
    await setPlan(args, { env, log });
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
