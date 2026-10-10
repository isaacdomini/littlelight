import type { FastifyBaseLogger } from "fastify";
import { requireConsent, type Tx, type TxContext } from "../auth";
import { ApiError, babyTrashed, notFound } from "../lib/errors";
import { type BabyAccess, babyAccess } from "../photos/queries";
import { type GoogleError, isGoogleError } from "./google/client";

// Guards and error helpers shared by the import routes (docs/plans/step-10.md 2.6).

/** Same body as the upload routes for strangers (no existence oracle). */
export const babyNotFound = () =>
  notFound("That album doesn't exist or you don't have access to it");
export const sourceNotFound = () => notFound("That album sync doesn't exist or was turned off");
export const batchNotFound = () =>
  notFound("That import doesn't exist or you don't have access to it");
export const appleSyncAdminsOnly = () =>
  new ApiError(403, "forbidden", "Only a parent who manages this album can turn on album sync");
export const notBatchRequester = () =>
  new ApiError(403, "not_requester", "Only the person who started this import can cancel it");

/** Consent, then membership (404 for strangers). Optionally refuse a trashed album (409). */
export async function requireMember(
  client: Tx,
  ctx: Pick<TxContext, "uid">,
  babyId: string,
  opts: { live?: boolean } = {},
): Promise<BabyAccess> {
  await requireConsent(client, ctx);
  const access = await babyAccess(client, ctx.uid, babyId);
  if (!access) throw babyNotFound();
  if (opts.live && access.deletedAt !== null) throw babyTrashed();
  return access;
}

/**
 * A Google failure as an API error. Logs the category only (never Google's text, a token or a
 * URL). `google_reconnect` is handled by `mintAccessToken` (it flags the row first).
 */
export function googleFailure(
  err: GoogleError,
  log: Pick<FastifyBaseLogger, "warn">,
  what: string,
): ApiError {
  log.warn({ category: err.category, status: err.status }, `google ${what} failed`);
  switch (err.category) {
    case "google_reconnect":
      return new ApiError(
        409,
        "google_reconnect",
        "Google Photos needs to be connected again. Reconnect and try once more.",
      );
    case "rate_limited":
      return new ApiError(
        429,
        "rate_limited",
        "Google Photos is busy right now, try again in a minute",
        undefined,
        { retryAfterSec: 60 },
      );
    case "network":
      return new ApiError(503, "internal", "Google Photos isn't responding, try again shortly");
    default:
      return new ApiError(502, "internal", "Google Photos didn't accept the request, try again");
  }
}

/** Rethrow `err` as an API error when it is a Google failure. */
export function rethrowGoogle(
  err: unknown,
  log: Pick<FastifyBaseLogger, "warn">,
  what: string,
): never {
  if (isGoogleError(err)) throw googleFailure(err, log, what);
  throw err;
}
