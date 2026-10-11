import { type ClientKind, emailShape, maskEmail } from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import { emailNotAllowed, familyLimited } from "../lib/errors";
import { type Tx, withServiceRole } from "./context";
import type { DomainBlocklist } from "./disposable";
import { hashFamilyIp } from "./ip-hash";

// Family-start safeguards (docs/plans/step-11.md, amended: 2.1, 2.4, D-B, D-J). Sign-up is never
// refused for abuse reasons; the checks run when an account starts a family, i.e. creates its
// first album while it is a parent nowhere (`POST /babies` with `my_family_id()` NULL):
// - disposable domain: 400 `email_not_allowed` (no exemption: a guest join never needs a family);
// - network cap: `FAMILIES_PER_IP_PER_DAY` family starts per HMAC'd client IP per rolling 24 h,
//   counted in `family_starts`: 429 `family_limited` + `Retry-After`. A hard cap under
//   concurrency: the guard transaction takes `pg_advisory_xact_lock(1015, hashtext(hex(ip_hash)))`,
//   counts, and reserves a ledger row (`family_id` NULL) before it commits, so N parallel first
//   albums from one network admit exactly the remaining count. The caller then fills the
//   reservation with the new family (`recordFamilyStart`) or deletes it (`releaseFamilyStart`)
//   when no family was started (insert refused or failed, or a concurrent first album won);
// - canonical duplicate: arbitrated by the database (`babies_set_family`, migration 21) inside
//   the album insert; `familyHolderEmailHint` only builds the masked hint of the 409.
// Everything runs as service_role under a named reason: the helpers and the ledger are
// service_role-only (they answer questions about other accounts). Nothing here logs: callers log
// the outcome only, never the email, the IP or its hash.

type App = Pick<FastifyInstance, "db" | "log" | "config">;

export interface FamilyStartFlags {
  /** Canonicalisation stripped a `+tag` from the founder's address. */
  plusTag: boolean;
  /** Canonicalisation folded Gmail dots. */
  dotsFolded: boolean;
}

export interface FamilyStartInput {
  /** The signed-in address (JWT claim); `null` when the provider gave none. */
  email: string | null;
  /** Client IP: hashed here, never stored or logged raw. */
  ip: string;
  /** `CF-IPCountry`: stored on the reservation (two characters, else NULL). */
  country: string | null;
  client: ClientKind;
  /** The caller (`auth_uid()`): the reservation's `user_id`. */
  userId: string;
}

export interface FamilyStartVerdict {
  flags: FamilyStartFlags;
  /** HMAC-SHA256 of the IP (already stored on the reservation; never log it). */
  ipHash: Buffer;
  /** `family_starts.id` of the reserved row (bigint as a string). */
  reservationId: string;
}

const DAY_SEC = 24 * 60 * 60;
const COUNTRY_RE = /^[A-Z0-9]{2}$/;
/** Advisory-lock class of the per-network cap (packages/db/README.md, "Advisory-lock classes"). */
export const FAMILY_START_LOCK_CLASS = 1015;

/**
 * Guards for a family start, run before the album insert. Throws 400 `email_not_allowed`
 * (disposable or deny-listed domain) or 429 `family_limited` (`Retry-After` = seconds until the
 * limit-th newest `family_starts` row of this network leaves the 24 h window, i.e. until one more
 * start fits). An account without an email skips the domain check (nothing to check). On success
 * a ledger row is reserved for this start; the caller must fill or release it.
 */
export async function familyStartGuards(
  app: App,
  blocklist: DomainBlocklist,
  limitPerDay: number,
  input: FamilyStartInput,
): Promise<FamilyStartVerdict> {
  if (input.email && blocklist.isBlockedEmail(input.email)) throw emailNotAllowed();
  const ipHash = hashFamilyIp(app.config, input.ip);
  const shape = input.email ? emailShape(input.email) : null;
  const flags: FamilyStartFlags = {
    plusTag: shape?.plusTag ?? false,
    dotsFolded: shape?.dotsFolded ?? false,
  };
  const country = input.country && COUNTRY_RE.test(input.country) ? input.country : null;
  const reservationId = await withServiceRole(app, "family-start guards", async (client) => {
    // Serialise the starts of one network: count and reserve under the same lock, released at
    // commit, so a concurrent start sees this reservation.
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext(encode($2, 'hex')))", [
      FAMILY_START_LOCK_CLASS,
      ipHash,
    ]);
    // The limit-th newest row inside the window (reservations included): if it exists the cap
    // is reached, and the cap frees up when it leaves the window.
    const { rows } = await client.query<{ retry_after: number }>(
      `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (created_at + interval '24 hours' - now()))))::int AS retry_after
         FROM public.family_starts
        WHERE ip_hash = $1 AND created_at > now() - interval '24 hours'
        ORDER BY created_at DESC
       OFFSET $2 LIMIT 1`,
      [ipHash, Math.max(0, limitPerDay - 1)],
    );
    const row = rows[0];
    if (row) throw familyLimited(Math.min(row.retry_after, DAY_SEC));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO public.family_starts (family_id, user_id, ip_hash, ip_country, client, plus_tag, dots_folded)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [input.userId, ipHash, country, input.client, flags.plusTag, flags.dotsFolded],
    );
    const id = reserved.rows[0]?.id;
    if (!id) throw new Error("family-start reservation not written");
    return id;
  });
  return { flags, ipHash, reservationId };
}

export interface RecordFamilyStartInput {
  /** From `familyStartGuards`. */
  reservationId: string;
  /** The family the album insert started. */
  familyId: string;
}

/**
 * The album insert started a family: fill the reservation with it, then prune rows past the
 * 30-day retention. If this fails the reservation stays (family_id NULL) and keeps counting
 * against the network, which errs on the safe side.
 */
export async function recordFamilyStart(app: App, input: RecordFamilyStartInput): Promise<void> {
  await withServiceRole(app, "family-start ledger", async (client) => {
    await client.query(
      "UPDATE public.family_starts SET family_id = $2 WHERE id = $1::bigint AND family_id IS NULL",
      [input.reservationId, input.familyId],
    );
    await client.query("SELECT public.family_starts_prune()");
  });
}

/**
 * No family was started after all (the insert was refused or failed, or a concurrent first
 * album of the same account started the family): drop the reservation so it does not count.
 */
export async function releaseFamilyStart(app: App, reservationId: string): Promise<void> {
  await withServiceRole(app, "family-start ledger", async (client) => {
    await client.query(
      "DELETE FROM public.family_starts WHERE id = $1::bigint AND family_id IS NULL",
      [reservationId],
    );
  });
}

/**
 * The 409 `inbox_has_family` hint: the address of the live account with the same canonical form
 * as `email` that is already a parent, masked (`m***@gmail.com`); `null` when none. The unmasked
 * address never leaves this function and never reaches a log line.
 */
export async function familyHolderEmailHint(app: App, email: string): Promise<string | null> {
  const holder = await withServiceRole(app, "family-start guards", async (client) => {
    const { rows } = await client.query<{ address: string | null }>(
      "SELECT public.family_holder_email_for_canonical(public.email_canonical($1)) AS address",
      [email],
    );
    return rows[0]?.address ?? null;
  });
  return holder ? maskEmail(holder) : null;
}

/**
 * The caller's own family (`my_family_id()`, under the caller's claims), or `null` when the
 * caller is a parent nowhere: their next album starts a family and runs `familyStartGuards`.
 */
export async function callerFamilyId(tx: Tx): Promise<string | null> {
  const { rows } = await tx.query<{ family_id: string | null }>(
    "SELECT public.my_family_id() AS family_id",
  );
  return rows[0]?.family_id ?? null;
}

/**
 * `POST /auth/otp` pre-check (suspension only, step 11): `true` when the account holding exactly
 * this address is suspended (the route answers the usual 202 and sends nothing). Runs for every
 * address so a suspended one costs the same as any other.
 */
export async function isSuspendedEmail(app: App, email: string): Promise<boolean> {
  return withServiceRole(app, "otp suspended check", async (client) => {
    const { rows } = await client.query<{ state: "none" | "active" | "suspended" }>(
      "SELECT public.account_state_for_email($1) AS state",
      [email],
    );
    return rows[0]?.state === "suspended";
  });
}
