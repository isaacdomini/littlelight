import { z } from "zod";

// JWT claim shapes that become `request.jwt.claims` (docs/plans/step-2.md 2.3, 2.11).
//
// The API verifies the token signature with `JWT_SECRET` first (step 3), then parses the payload
// with these schemas, then runs every request-scoped unit of work as:
//   BEGIN; SET LOCAL ROLE <claims.role>; SELECT set_config('request.jwt.claims', $1, true); ...
// with `$1 = claimsToSql(claims)` as a bind parameter. Claims (and the token) are never logged.
//
// SQL reads only: `role`, `sub` + `email` (authenticated), `share_link_id` (viewer). `auth_uid()`
// returns `sub` only when role = 'authenticated'; `auth_share_link_id()` returns `share_link_id`
// only when role = 'viewer', so one claim set can never act as both.

/** GoTrue sometimes emits `"email": ""` (e.g. identities without an email); treat it as absent. */
const optionalEmail = z.preprocess((v) => (v === "" ? undefined : v), z.email().optional());

/**
 * A signed-in user, as minted by self-hosted GoTrue. Unknown GoTrue claims (`app_metadata`,
 * `session_id`, `amr`, ...) are kept (loose object) so the SQL side sees GoTrue's own claim set.
 */
export const authenticatedClaimsSchema = z.looseObject({
  sub: z.uuid(),
  role: z.literal("authenticated"),
  email: optionalEmail,
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative().optional(),
  iss: z.string().optional(),
});
export type AuthenticatedClaims = z.infer<typeof authenticatedClaimsSchema>;

/**
 * A share-link viewer (no account). Minted by the API in step 8 and signed with `JWT_SECRET`.
 * Unknown keys are stripped: a viewer token carries nothing else into SQL (in particular no `sub`).
 */
export const viewerClaimsSchema = z.object({
  role: z.literal("viewer"),
  share_link_id: z.uuid(),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative().optional(),
  jti: z.string().min(1).optional(),
});
export type ViewerClaims = z.infer<typeof viewerClaimsSchema>;

/** Either claim set, discriminated by `role`. */
export const jwtClaimsSchema = z.discriminatedUnion("role", [
  authenticatedClaimsSchema,
  viewerClaimsSchema,
]);
export type JwtClaims = z.infer<typeof jwtClaimsSchema>;

/**
 * The string bound to `set_config('request.jwt.claims', $1, true)`: `JSON.stringify` of the
 * parsed claims. Re-parses so only a validated claim set (viewer extras stripped) ever reaches
 * SQL; throws a `ZodError` otherwise. Never interpolate the result into SQL text, never log it.
 */
export function claimsToSql(claims: JwtClaims): string {
  return JSON.stringify(jwtClaimsSchema.parse(claims));
}
