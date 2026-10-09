import { reviewBabyId } from "@littlelight/db/review";
import { reviewAccountEnabled, reviewAccountEnvSchema } from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import { type ApiConfig, ConfigError } from "../config";
import { verifyPasscode } from "../sharing/crypto";
import { withServiceRole } from "./context";

// Store-review sign-in (docs/plans/step-9.md 2.5, 6 D4; user decision 2026-10-09). App Review
// and Play "App access" cannot receive our email codes, so exactly one configured email may sign
// in with a static 6-digit code instead:
//
// - Off unless BOTH `REVIEW_ACCOUNT_EMAIL` and `REVIEW_ACCOUNT_CODE_HASH` are set (api only),
//   read from `app.config` only (`loadConfig`), never from the ambient environment. One without
//   the other, or a malformed hash, fails boot (`ConfigError`, field names only).
// - `POST /auth/otp` for that email sends nothing (still 202, same throttles).
// - `POST /auth/verify` for that email accepts only a code matching the scrypt hash (constant
//   time, `verifyPasscode`); the normal 5-per-10-min per-email throttle counts every attempt.
//   On a match the session is minted through GoTrue's admin `generate_link` + `verify` (no email
//   is sent) and audited as `auth.sign_in {method:"review"}`.
// - Guard, in EVERY environment: refused unless the account belongs to no baby other than
//   `reviewBabyId(userId)` (the synthetic family from `pnpm db:review-family`). A static code
//   skips proof of mailbox ownership, so it must never open a real family. (The provisioning
//   script only warns about other memberships outside production; the sign-in never relaxes.)
// - While enabled, the review account cannot accept invites (invites.ts), so it cannot join a
//   real family during a session that passed the guard.
// - Nothing about the code or hash is ever logged; logs carry the user id and counts only.

export interface ReviewAccount {
  /** Normalised like every email (`emailSchema`), so it compares equal to parsed request bodies. */
  email: string;
  /** `scrypt$1$N$r$p$salt$dk` (sharing/crypto.ts `hashPasscode`). Never log. */
  codeHash: string;
}

/**
 * The review account from the API config, or `null` when off. `app.config` is the single
 * source: `loadConfig` already normalised the two variables (unset, empty and whitespace-only
 * are all off), and nothing here reads `process.env`, so a developer's shell cannot switch the
 * review sign-in on for a `testConfig()` app. The values are re-validated anyway, so a config
 * built by hand (tests, future callers) with only one of the two set, or a malformed hash,
 * still fails closed with a `ConfigError` instead of half-enabling the account.
 */
export function loadReviewAccount(config: ApiConfig): ReviewAccount | null {
  const input = {
    REVIEW_ACCOUNT_EMAIL: config.REVIEW_ACCOUNT_EMAIL,
    REVIEW_ACCOUNT_CODE_HASH: config.REVIEW_ACCOUNT_CODE_HASH,
  };
  const parsed = reviewAccountEnvSchema.safeParse(input);
  if (!parsed.success) {
    // zod messages describe the expectation, never the received value.
    throw new ConfigError([
      ...new Set(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} (${i.message})`)),
    ]);
  }
  if (!reviewAccountEnabled(parsed.data)) return null;
  return {
    email: parsed.data.REVIEW_ACCOUNT_EMAIL,
    codeHash: parsed.data.REVIEW_ACCOUNT_CODE_HASH,
  };
}

/** True when `email` (already normalised by `emailSchema`) is the configured review account. */
export function isReviewEmail(review: ReviewAccount | null, email: string | null): boolean {
  return review !== null && email !== null && email === review.email;
}

/** Constant-time check of the static code; `false` for anything that is not 6 digits. */
export function verifyReviewCode(review: ReviewAccount, code: string): Promise<boolean> {
  return verifyPasscode(code, review.codeHash);
}

/**
 * Number of babies the user belongs to other than their review baby (service_role: there is no
 * session yet). Counts trashed babies too: a restore would bring them back.
 */
export async function countOtherFamilies(
  app: Pick<FastifyInstance, "db" | "log" | "config">,
  userId: string,
): Promise<number> {
  return withServiceRole(app, "review sign-in membership guard", async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.baby_members WHERE user_id = $1 AND baby_id <> $2",
      [userId, reviewBabyId(userId)],
    );
    return rows[0]?.n ?? 0;
  });
}
