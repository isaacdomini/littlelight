import {
  consentRequestSchema,
  type MeResponse,
  meResponseSchema,
  PRIVACY_VERSION,
  type Profile,
  profileUpdateSchema,
  TERMS_VERSION,
  type Units,
} from "@littlelight/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth, requireConsent, type Tx, type TxContext, withClaims } from "../auth";
import { ApiError } from "../lib/errors";
import { clientCountry } from "../lib/request";
import { listBabySummaries } from "./babies";

// `/me` routes (docs/plans/step-3.md 2.4; PRD "Sign-up flow" steps 3-4). `GET /me` is the SPA's
// one bootstrap call and runs as a single `withClaims` transaction. The caller's own `profiles`
// row is reached through RLS (`user_id = auth_uid()`); the API passes `ctx.uid` only so queries
// are explicit, never to widen access. `DELETE /me` and `/me/deletion-preview` live in
// `auth/account.ts` (security-engineer).
//
// Privacy: consent stores the IP *country* only (`CF-IPCountry`), never the IP. Nothing here
// logs request bodies (display names, labels) or emails.

interface ProfileRow {
  user_id: string;
  display_name: string;
  relationship_label: string | null;
  timezone: string;
  units: Units;
  terms_version: string | null;
  privacy_version: string | null;
  accepted_at: Date | null;
}

function toProfile(r: ProfileRow): Profile {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    relationshipLabel: r.relationship_label,
    timezone: r.timezone,
    units: r.units,
    termsVersion: r.terms_version,
    privacyVersion: r.privacy_version,
    acceptedAt: r.accepted_at?.toISOString() ?? null,
  };
}

async function loadMe(client: Tx, ctx: TxContext): Promise<MeResponse> {
  const { rows } = await client.query<ProfileRow>(
    `SELECT user_id, display_name, relationship_label, timezone, units, terms_version,
            privacy_version, accepted_at
       FROM public.profiles WHERE user_id = $1`,
    [ctx.uid],
  );
  const profile = rows[0] ? toProfile(rows[0]) : null;
  const consentOk =
    profile?.termsVersion === TERMS_VERSION && profile.privacyVersion === PRIVACY_VERSION;
  return {
    user: { id: ctx.uid, email: ctx.email },
    profile,
    consent: {
      ok: consentOk,
      requiredTermsVersion: TERMS_VERSION,
      requiredPrivacyVersion: PRIVACY_VERSION,
    },
    profileComplete: profile !== null && consentOk && profile.displayName.trim() !== "",
    babies: await listBabySummaries(client, ctx.uid),
    session: { createdAt: ctx.sessionCreatedAt.toISOString(), isFresh: ctx.isFresh },
  };
}

/** `Area/Location[/Sub]` with IANA's character set (no offsets like `+05:30`). */
const IANA_NAME = /^[A-Z][A-Za-z_-]*(?:\/[A-Z][A-Za-z0-9_+-]*){1,2}$/;

let zoneCache: ReadonlySet<string> | undefined;
function supportedZones(): ReadonlySet<string> {
  zoneCache ??= new Set(Intl.supportedValuesOf("timeZone"));
  return zoneCache;
}

/**
 * The IANA zone to store, or null when unknown. Accepts what `Intl.supportedValuesOf` lists, plus
 * `UTC` (the column default, which ICU leaves out of that list) and IANA names that ICU resolves
 * to a listed zone (browsers report e.g. `Asia/Kolkata` while ICU lists `Asia/Calcutta`); the
 * client's spelling is kept in that case. Exported for unit tests.
 */
export function normalizeTimeZone(input: string): string | null {
  const zones = supportedZones();
  if (input === "UTC" || zones.has(input)) return input;
  if (!IANA_NAME.test(input)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return resolved === "UTC" || zones.has(resolved) ? input : null;
}

/** Profile field → column (fixed map: column names never come from input). */
const PROFILE_COLUMNS = {
  displayName: "display_name",
  relationshipLabel: "relationship_label",
  timezone: "timezone",
  units: "units",
} as const;

export function meRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: "GET",
    url: "/me",
    schema: { response: { 200: meResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => withClaims(request, (client, ctx) => loadMe(client, ctx)),
  });

  r.route({
    method: "POST",
    url: "/me/consent",
    schema: { body: consentRequestSchema, response: { 200: meResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const body = request.body;
      const country = clientCountry(request);
      return withClaims(request, async (client, ctx) => {
        // Nothing is stored for a minor (PRD "Block under-18 sign-ups").
        if (!body.isAdult) {
          throw new ApiError(403, "under_18", "You must be 18 or older to use Littlelight");
        }
        if (body.termsVersion !== TERMS_VERSION || body.privacyVersion !== PRIVACY_VERSION) {
          throw new ApiError(
            409,
            "consent_version_outdated",
            "The Terms or Privacy Policy changed, please review them again",
            { requiredTermsVersion: TERMS_VERSION, requiredPrivacyVersion: PRIVACY_VERSION },
          );
        }
        // Upsert: the row normally exists (created at sign-in). Re-accepting the same versions
        // keeps the original acceptance record; a version change records a new one.
        await client.query(
          `INSERT INTO public.profiles
             (user_id, terms_version, privacy_version, accepted_at, accepted_ip_country)
           VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (user_id) DO UPDATE SET
             accepted_at = CASE
               WHEN public.profiles.terms_version IS NOT DISTINCT FROM EXCLUDED.terms_version
                AND public.profiles.privacy_version IS NOT DISTINCT FROM EXCLUDED.privacy_version
                AND public.profiles.accepted_at IS NOT NULL
               THEN public.profiles.accepted_at ELSE EXCLUDED.accepted_at END,
             accepted_ip_country = CASE
               WHEN public.profiles.terms_version IS NOT DISTINCT FROM EXCLUDED.terms_version
                AND public.profiles.privacy_version IS NOT DISTINCT FROM EXCLUDED.privacy_version
                AND public.profiles.accepted_at IS NOT NULL
               THEN public.profiles.accepted_ip_country ELSE EXCLUDED.accepted_ip_country END,
             terms_version = EXCLUDED.terms_version,
             privacy_version = EXCLUDED.privacy_version`,
          [ctx.uid, TERMS_VERSION, PRIVACY_VERSION, country],
        );
        return loadMe(client, ctx);
      });
    },
  });

  r.route({
    method: "PATCH",
    url: "/me/profile",
    schema: { body: profileUpdateSchema, response: { 200: meResponseSchema } },
    preHandler: requireAuth,
    handler: async (request) => {
      const body = request.body;
      const update: Partial<Record<keyof typeof PROFILE_COLUMNS, string>> = {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.relationshipLabel !== undefined
          ? { relationshipLabel: body.relationshipLabel }
          : {}),
        ...(body.units !== undefined ? { units: body.units } : {}),
      };
      if (body.timezone !== undefined) {
        const zone = normalizeTimeZone(body.timezone);
        if (!zone) {
          throw new ApiError(400, "validation_failed", "Unknown time zone", {
            fields: ["body.timezone"],
          });
        }
        update.timezone = zone;
      }
      return withClaims(request, async (client, ctx) => {
        await requireConsent(client, ctx);
        const sets: string[] = [];
        const values: unknown[] = [ctx.uid];
        for (const [field, value] of Object.entries(update) as [
          keyof typeof PROFILE_COLUMNS,
          string,
        ][]) {
          values.push(value);
          sets.push(`${PROFILE_COLUMNS[field]} = $${values.length}`);
        }
        // requireConsent proved the row exists; RLS limits the UPDATE to the caller's own row.
        await client.query(
          `UPDATE public.profiles SET ${sets.join(", ")} WHERE user_id = $1`,
          values,
        );
        return loadMe(client, ctx);
      });
    },
  });
}
