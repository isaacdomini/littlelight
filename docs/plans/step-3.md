# Step 3 plan: Auth and onboarding

Status: proposed (architect, 2026-10-08). PRD step: "Build handoff for Claude Code → Build order →
3. Auth and onboarding: email OTP, Apple, Google; sign-up flow steps 1–8; invites; account
deletion." Acceptance (verbatim): "e2e test signs up, creates a baby, invites a co-admin, and the
invitee accepts with the matching email; mismatched email is rejected."

PRD sections implemented: "Accounts and authentication" (Sign-in methods, Sign-up flow, Roles and
permissions, Invites, Sessions and tokens, Account deletion and recovery, Auth security
requirements, Auth data model additions); "FR-1 Accounts and baby spaces"; "Non-functional
requirements → Security / Accessibility and UX"; "Mobile and Capacitor → Frontend stack /
Capacitor plugins" (interfaces only; native work is step 9); "Build handoff → Conventions".
`CLAUDE.md` clarifications applied: email 6-digit OTP primary, magic link web-only fallback,
passwordless only; self-hosted GoTrue at `/auth`; the API verifies GoTrue JWTs with `JWT_SECRET`
and sets `request.jwt.claims` per transaction. Per the user's instruction there is **no per-step
reviewer pass**; one combined review runs after step 9.

## 1. Goal

Make a real person able to sign up and sign in with an emailed 6-digit code (magic link as the
web fallback), accept the terms as an adult, fill a profile, create a baby, invite a co-admin or
contributor by email, accept an invite only with the invited email, switch between babies, see
and sign out devices, and delete the account; with Apple/Google sign-in fully wired but switched
off until the user supplies credentials. Under the hood: the API becomes the only client of
GoTrue (browser-facing GoTrue is reduced to the OAuth redirect endpoints), issues web sessions as
httpOnly cookies and native sessions as bearer tokens, verifies every JWT, and runs every unit of
work inside the step-2 per-transaction identity pattern (`BEGIN; SET LOCAL ROLE …;
set_config('request.jwt.claims', $1, true)`) with a release path that provably returns the
pooled connection as `tinyglow_api`. A Playwright e2e against the dev stack, reading codes and
invite links from Mailpit, proves the acceptance check and runs in CI's dev-stack job.

## 2. Interfaces first

Everything here is a contract; agents build to it without asking each other. Deviations go
through the orchestrator.

### 2.1 Topology and trust boundaries

```
browser/app ──/api/*──► api (Fastify) ──http://auth:9999──► GoTrue ──► Postgres auth.*
     │                      │ tinyglow_api, SET LOCAL ROLE per txn ──► Postgres public.*
     │                      └─SMTP──► mail (Mailpit) / Postmark|Resend
     └──/auth/authorize, /auth/callback, /auth/health only ──► GoTrue (OAuth redirects)
```

- **GoTrue is reachable from outside only for** `GET /auth/health`, `GET /auth/authorize`,
  `GET|POST /auth/callback`. nginx (prod) and the Vite proxy (dev) answer 404 for every other
  `/auth/*` path. Reason: OTP/verify/refresh/logout must go through the API so the PRD's
  per-email/per-IP limits, Turnstile, generic responses, audit log and cookie handling apply,
  and no password endpoint (`/auth/signup`, `/auth/token?grant_type=password`) is reachable.
- **Web sessions**: httpOnly cookies set by the API (the `@supabase/ssr` "server exchanges and
  stores" pattern, implemented by our API instead of a Next.js server). PKCE is used for OAuth;
  email links carry a single-use `token_hash` in the URL fragment (never sent to a server log).
- **Native sessions (step 9)**: bearer access token + refresh token in the response body, stored
  in Keychain/Keystore by the app; the same endpoints, selected by a request header.
- **No `@supabase/supabase-js` or `@supabase/ssr`** in the frontend: the SPA talks only to
  `/api/auth/*` (plus a top-level navigation to `/auth/authorize` for OAuth). See D1.

### 2.2 Session model

| Item | Web | Native (step 9) |
| --- | --- | --- |
| Transport in | cookie `ll_access` | `Authorization: Bearer <access>` |
| Refresh | cookie `ll_refresh` (Path `/api/auth`, SameSite=Strict, Max-Age 30 d, re-issued on every refresh ⇒ 30-day inactivity timeout) | body `{refreshToken}`; GoTrue session inactivity 90 d |
| Header | `X-Tinyglow-Client: web` on every cookie-authenticated request (CSRF: custom header + SameSite; the API rejects cookie-authenticated non-GET requests without it with 403 `csrf_rejected`) | `X-Tinyglow-Client: native` ⇒ tokens returned in the body, no cookies |
| Access JWT | GoTrue HS256, 1 h (`GOTRUE_JWT_EXP=3600`), claims per `authenticatedClaimsSchema` (+ `session_id`) | same |
| Rotation | GoTrue: `SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true`, `REUSE_INTERVAL=10` s; reuse of an old refresh token revokes the family (GoTrue built-in) | same |
| Inactivity | 30 d (cookie Max-Age) | 90 d (`GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=2160h`, one global value; the web cookie is the shorter bound) |
| Liveness | every `withClaims` transaction calls `auth_session_info(session_id)`; a deleted session ⇒ 401 `session_revoked` within one request, so "sign out per device / everywhere" and account deletion take effect immediately, not after the JWT's hour | same |
| Fresh sign-in | `auth.sessions.created_at` of the current session ≤ 10 min ago. Re-verifying by email code creates a new GoTrue session (and the API logs out the old one locally), which is how the UI satisfies "fresh sign-in" for delete baby, remove co-admin, delete account | same |

Cookie attributes: `ll_access`: `HttpOnly; SameSite=Lax; Path=/api; Max-Age=3600; Secure` (Secure
only when `NODE_ENV=production`). `ll_refresh`: `HttpOnly; SameSite=Strict; Path=/api/auth;
Max-Age=2592000; Secure`. Sign-out clears both (`Max-Age=0`).

### 2.3 Auth flows (API ⇄ GoTrue)

| Flow | Client → API | API → GoTrue (`AUTH_INTERNAL_URL`) | Notes |
| --- | --- | --- | --- |
| Request code | `POST /api/auth/otp {email, captchaToken?}` → always `202 {ok:true}` | `POST /otp {email, create_user:true}` | Normalised email (trim, lower). Limits 2.9. Generic response even if GoTrue errors (logged at warn with error category only). |
| Verify code | `POST /api/auth/verify {email, code}` | `POST /verify {type:"email", email, token}` | 5 tries per email per 10 min → 429. GoTrue 4xx → 400 `invalid_code` ("That code is wrong or has expired"). |
| Magic link (web only) | email link `{{ .SiteURL }}/signin/callback#token_hash=…&type=email`; SPA reads the fragment → `POST /api/auth/verify {tokenHash, type:"email"}` | `POST /verify {type:"email", token_hash}` | Fragment never reaches nginx logs; hash is single-use, 10 min. |
| OAuth web (Apple/Google) | SPA generates PKCE verifier (sessionStorage) and navigates to `/auth/authorize?provider=…&redirect_to=${PUBLIC_URL}/signin/callback&code_challenge=…&code_challenge_method=s256`; back at `/signin/callback?code=…` → `POST /api/auth/pkce {code, codeVerifier}` | `POST /token?grant_type=pkce {auth_code, code_verifier}` | Only shown when `GET /api/auth/config` says the provider is enabled. Verified-email auto-link is GoTrue's default behaviour (unverified provider emails are refused, never linked). |
| OAuth native (step 9) | `POST /api/auth/id-token {provider, idToken, nonce?, accessToken?}` | `POST /token?grant_type=id_token` | Implemented now (same proxy shape), exercised in step 9. |
| Refresh | `POST /api/auth/refresh` (web: cookie; native: `{refreshToken}`) | `POST /token?grant_type=refresh_token` | Rotates both cookies / returns new tokens. Failure ⇒ 401 `unauthorized` + cookies cleared. |
| Sign out | `POST /api/auth/signout {scope:"local"\|"global"}` | `POST /logout?scope=…` with the user's access token | Clears cookies; audit `auth.sign_out`. |
| Sessions | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` | none (SQL functions 2.5) | Per-device sign-out. Deleting the current session also clears cookies. |
| Account delete | `DELETE /api/me` | `DELETE /admin/users/{id}` with an API-minted `service_role` JWT (`jose`, HS256, exp 60 s, `iss` = `${PUBLIC_URL}/auth`, `aud` `authenticated`) | Cascades `auth.sessions`, `auth.identities`, `public.profiles` → `baby_members`, chat. |

On every session-issuing response the API: creates the `profiles` row if missing
(`INSERT … ON CONFLICT DO NOTHING` under the new claims; needed before any `audit_log` row because
`actor_user_id` references `profiles`), writes audit `auth.sign_in`, and if the user already had
another live session writes `auth.new_device` and sends the new-device email (2.8). The API
forwards the client IP as `X-Forwarded-For` and `CF-Connecting-IP` and the `User-Agent` to GoTrue
so `auth.sessions.ip/user_agent` and GoTrue's own rate limits see the real client.

Client IP = `CF-Connecting-IP` header when present, else Fastify `request.ip` with
`trustProxy: true` (nginx/Vite are the only hops; port 3000 is not public). Country =
`CF-IPCountry` header or `null`.

### 2.4 API routes

All under the `/api` prefix (stripped by nginx/Vite; the API registers them without it). Bodies
and responses are validated with the zod schemas in 2.6 (`fastify-type-provider-zod`). Errors are
`{ error: <code>, message, details? }` (`apiErrorSchema`); codes listed in 2.6. "Auth" = needs a
valid session; "Consent" = also needs an accepted current consent; "Fresh" = fresh sign-in.

| Method, path | Owner file | Guards | Request → Response | Notes |
| --- | --- | --- | --- | --- |
| `GET /auth/config` | `auth/routes.ts` | – | → `authConfigResponse` | `{providers:{apple,google}, turnstileSiteKey, termsVersion, privacyVersion}` from env + constants |
| `POST /auth/otp` | `auth/routes.ts` | – | `otpRequest` → 202 `{ok:true}` | 2.3, limits 2.9, Turnstile 2.9 |
| `POST /auth/verify` | `auth/routes.ts` | – | `verifyRequest` → `sessionResponse` | sets cookies (web) or returns `tokens` (native). If a valid session for the same user is already present (re-verify), GoTrue `logout?scope=local` on the old one first |
| `POST /auth/pkce` | `auth/routes.ts` | – | `pkceExchangeRequest` → `sessionResponse` | 400 `provider_disabled` when both providers are off |
| `POST /auth/id-token` | `auth/routes.ts` | – | `idTokenRequest` → `sessionResponse` | 400 `provider_disabled` unless that provider is enabled |
| `POST /auth/refresh` | `auth/routes.ts` | – | `refreshRequest` → `sessionResponse` | |
| `POST /auth/signout` | `auth/routes.ts` | Auth | `signOutRequest` → 204 | |
| `GET /auth/sessions` | `auth/sessions.ts` | Auth | → `sessionsListResponse` | `current` flag; UA reduced to a label ("Safari on iPhone"); no IPs |
| `DELETE /auth/sessions/:id` | `auth/sessions.ts` | Auth | → 204 | own sessions only (function enforces); audit `auth.sign_out {scope:"device"}` |
| `GET /me` | `routes/me.ts` | Auth | → `meResponse` | one bootstrap call: user, profile (or null), consent state, babies with role, session freshness |
| `POST /me/consent` | `routes/me.ts` | Auth | `consentRequest` → `meResponse` | `isAdult:false` ⇒ 403 `under_18`; versions must equal `TERMS_VERSION`/`PRIVACY_VERSION` ⇒ else 409 `consent_version_outdated`; stores `accepted_at`, `accepted_ip_country` |
| `PATCH /me/profile` | `routes/me.ts` | Auth, Consent | `profileUpdate` → `meResponse` | timezone validated against `Intl.supportedValuesOf('timeZone')` |
| `GET /me/deletion-preview` | `auth/account.ts` | Auth | → `deletionPreviewResponse` | `blockingBabies` (sole admin, live), `babiesKept`, `freshSignIn` |
| `DELETE /me` | `auth/account.ts` | Auth, Fresh | `deleteAccountRequest {acknowledge:true}` → 204 | 409 `sole_admin` with `details.babies` if blocked; see 2.7 |
| `GET /babies` | `routes/babies.ts` | Auth, Consent | → `babiesListResponse` | member babies, `deleted_at IS NULL` for non-admins; admins also see trashed (`deletedAt` set) |
| `POST /babies` | `routes/babies.ts` | Auth, Consent | `babyCreate` → 201 `baby` | `created_by = auth_uid()`; trigger adds admin; audit `baby.created` |
| `GET /babies/:id` | `routes/babies.ts` | Auth, Consent | → `baby` | |
| `PATCH /babies/:id` | `routes/babies.ts` | Auth, Consent, admin | `babyUpdate` → `baby` | no plan/billing columns (RLS column grants enforce) |
| `DELETE /babies/:id` | `routes/babies.ts` | Auth, Consent, admin, Fresh | → 204 | soft delete `deleted_at = now()`; audit `baby.deleted`; purge after 30 d is the worker's `purge.trash` job (step 4) |
| `GET /babies/:id/members` | `auth/members.ts` | Auth, Consent, member | → `membersListResponse` | members + live invites (admins only see invites) |
| `PATCH /babies/:id/members/:userId` | `auth/members.ts` | Auth, Consent, admin | `memberRoleUpdate` → `member` | trigger errors → 409 `admins_full` / `last_admin`; audit `member.role_changed` |
| `DELETE /babies/:id/members/:userId` | `auth/members.ts` | Auth, Consent | → 204 or 202 | contributor: admin removes immediately. Admin target: if `userId` = self ⇒ leave (Fresh; `last_admin` if alone). Otherwise ⇒ 202 and a **removal request** (2.5) is recorded; the target confirms. Audit `member.removed` / `member.removal_requested`. If the removed user is `plan_owner_user_id`, the baby reverts to `free` (trigger 2.5) |
| `POST /babies/:id/members/:userId/removal/confirm` | `auth/members.ts` | Auth, Consent, Fresh, `userId` = self | → 204 | target confirms their own removal (FR-1.5 "other admin's confirmation") |
| `POST /babies/:id/members/:userId/removal/decline` | `auth/members.ts` | Auth, Consent, (`userId` = self or admin) | → 204 | clears the request |
| `POST /babies/:id/invites` | `auth/invites.ts` | Auth, Consent, admin | `inviteCreate` → 201 `invite` | token = 32 random bytes base64url (43 chars), `token_hash = sha256(token)`; insert under `authenticated` (trigger 20/day ⇒ 429 `rate_limited`); live duplicate ⇒ 409 `invite_exists`; existing member ⇒ 409 `already_member`; role admin with 2 admins ⇒ 409 `admins_full`; email sent (2.8); audit `invite.sent`. **Never returns the token** |
| `POST /babies/:id/invites/:inviteId/resend` | `auth/invites.ts` | Auth, Consent, admin | → `invite` | rotates `token_hash`, `expires_at = now()+7 d`, re-sends; audit `invite.resent` |
| `DELETE /babies/:id/invites/:inviteId` | `auth/invites.ts` | Auth, Consent, admin | → 204 | `revoked_at = now()`; audit `invite.revoked` |
| `GET /invites/:token` | `auth/invites.ts` | – (IP limit 60/h) | → `inviteLookupResponse` | `service_role` lookup by hash; `{status, babyName, inviterName, role, maskedEmail, expiresAt}`; unknown token ⇒ 404 `invite_not_found` |
| `POST /invites/:token/accept` | `auth/invites.ts` | Auth, Consent | → `inviteAcceptResponse {babyId, role}` | `service_role`: hash lookup; expired/revoked/accepted ⇒ 410 `invite_expired`/`invite_revoked`/`invite_accepted`; `lower(claims.email) ≠ invite.email` ⇒ 403 `invite_email_mismatch`, message exactly `This invite was sent to ${maskEmail(invite.email)}`; `INSERT baby_members (baby_id, user_id, role, invited_by)` (the step-2 trigger consumes the invite; `baby already has two admins` ⇒ 409 `admins_full` "This album already has two admins"); audit `invite.accepted` |
| `GET /healthz` | `routes/healthz.ts` | – | unchanged body in dev; in production the full body only for loopback sockets (the container healthcheck), otherwise `{status}` only (closes step-1 S4) | |

Error mapping (`lib/errors.ts`): `ApiError(status, code, message, details?)`; `mapPgError`:
SQLSTATE `23514` by message — `baby already has two admins` → 409 `admins_full`, `baby must keep
at least one admin` → 409 `last_admin`, `invite rate limit` → 429 `rate_limited`, `invite is no
longer valid` → 410 `invite_expired`; `42501` → 403 `forbidden`; `23505` → 409 `conflict`;
anything else → 500 `internal` (message never includes SQL or parameters). Zod failures → 400
`validation_failed` with field paths only. 429 responses carry `Retry-After`.

### 2.5 Database changes (migration `1791600000100_auth-sessions-and-plan.sql`)

- Functions (SECURITY DEFINER, owner `postgres`, `SET search_path = pg_catalog, public, auth`,
  `REVOKE … FROM PUBLIC`; the only door into `auth.*`, no grants on `auth` tables to any role):
  - `auth_session_info(p_session_id uuid) RETURNS TABLE (created_at timestamptz, refreshed_at timestamptz)`: the row of `auth.sessions` **only if** `user_id = auth_uid()`; empty otherwise. Grant `authenticated`.
  - `list_user_sessions() RETURNS TABLE (id uuid, created_at, updated_at, refreshed_at timestamptz, user_agent text)`: sessions of `auth_uid()`, no `ip`. Grant `authenticated`.
  - `delete_user_session(p_session_id uuid) RETURNS boolean`: `DELETE FROM auth.sessions WHERE id = $1 AND user_id = auth_uid()` (GoTrue's `refresh_tokens` cascade). Grant `authenticated`.
  - `count_user_sessions() RETURNS integer` for new-device detection. Grant `authenticated`.
  - Guard at the top: raise if `to_regclass('auth.sessions') IS NULL` ("start the auth (GoTrue) service before running migrations").
- `baby_members`: add `removal_requested_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL`,
  `removal_requested_at timestamptz`. Written under `service_role` only (no new grants to
  `authenticated`: a self-updatable row would let a contributor rewrite `role`). Requests older
  than 7 days are ignored by the API.
- Plan follows the paying admin (settles the step-2 open issue): trigger
  `babies_plan_follows_owner` BEFORE UPDATE OF `plan_owner_user_id` ON `babies`: when it becomes
  NULL (FK `SET NULL` on user deletion fires row triggers) and `plan = 'plus'` ⇒ `NEW.plan :=
  'free'`, `NEW.entitlement_expires_at := NULL`. Trigger `baby_members_release_plan` AFTER DELETE
  ON `baby_members`: `UPDATE babies SET plan_owner_user_id = NULL WHERE id = OLD.baby_id AND
  plan_owner_user_id = OLD.user_id` (leaving/removal). Consequence: the baby loses AI (FR-5.8 gate
  `baby_ai_enabled` goes false; `photos_status_guard` and the `photo_ai` tripwire keep free-tier
  photos away from any model); existing photos above the 1,000 cap stay but no new ones can be
  added until re-upgrade. Tested in `triggers.integration.test.ts`.
- `profiles`: no new columns (onboarding progress is client state; consent + display_name are the
  server-side gates).
- `packages/db/src/test-support.ts`: the CI stub gains `auth.sessions (id uuid PK, user_id uuid
  REFERENCES auth.users ON DELETE CASCADE, created_at, updated_at, refreshed_at timestamptz,
  user_agent text, ip text, aal text, not_after timestamptz, tag text)` and `auth.refresh_tokens
  (id bigserial PK, token text, user_id text, session_id uuid REFERENCES auth.sessions ON DELETE
  CASCADE, revoked boolean, parent text, created_at, updated_at)` so API integration tests can
  create sessions. Regenerate `packages/db/src/generated` (`pnpm db:types`); down migration drops
  everything above.

### 2.6 Shared contracts (`@tinyglow/shared`, architect-defined, backend-engineer writes in 3.2)

`src/auth.ts` (constants + helpers):
`AUTH_COOKIE_ACCESS='ll_access'`, `AUTH_COOKIE_REFRESH='ll_refresh'`,
`CLIENT_HEADER='x-tinyglow-client'`, `clientKindSchema=z.enum(['web','native'])`,
`SPA_AUTH_CALLBACK_PATH='/signin/callback'`, `INVITE_PATH='/invite'`,
`ACCESS_TOKEN_TTL_SEC=3600`, `WEB_SESSION_IDLE_DAYS=30`, `NATIVE_SESSION_IDLE_DAYS=90`,
`FRESH_SIGN_IN_MAX_AGE_MIN=10`, `OTP_CODE_LENGTH=6`, `OTP_TTL_MIN=10`, `OTP_MAX_ATTEMPTS=5`,
`OTP_PER_EMAIL_PER_HOUR=5`, `OTP_PER_IP_PER_HOUR=30`, `OTP_CAPTCHA_AFTER_ATTEMPTS=3`,
`INVITE_LOOKUPS_PER_IP_PER_HOUR=60`, `MEMBER_REMOVAL_REQUEST_TTL_DAYS=7`,
`TERMS_VERSION='2026-10-08'`, `PRIVACY_VERSION='2026-10-08'`, `PLUS_PRICE_USD_MONTHLY=3.99`,
`RELATIONSHIP_LABELS=['Mom','Dad','Parent','Grandparent','Guardian','Nanny','Family','Other']`,
`normalizeEmail(s)` (trim + lowercase, NFC), `maskEmail('maria@gmail.com') === 'm***@gmail.com'`
(first char of the local part + `***@` + domain; one-char local parts become `*`), `userAgentLabel(ua)`
(coarse "Browser on Device" label), `AUDIT_EVENTS` as const + `auditEventSchema`:
`auth.sign_in`, `auth.sign_out`, `auth.new_device`, `invite.sent`, `invite.resent`,
`invite.accepted`, `invite.revoked`, `member.role_changed`, `member.removal_requested`,
`member.removed`, `baby.created`, `baby.deleted`, `account.deletion_requested`,
`account.deleted` (step 8 appends share events). Metadata rule (in a comment and enforced by a
unit test on `auditMetadataSchema`): only `ip_country`, `client`, `user_agent_label`, `role`,
`invite_id`, `scope`, `target_user_id`; never emails, IPs, tokens, GPS, notes.

`src/api/errors.ts`: `apiErrorCodeSchema = z.enum([...])` with `unauthorized`, `token_expired`,
`session_revoked`, `csrf_rejected`, `forbidden`, `not_found`, `conflict`, `validation_failed`,
`rate_limited`, `captcha_required`, `captcha_failed`, `invalid_code`, `provider_disabled`,
`consent_required`, `under_18`, `consent_version_outdated`, `fresh_sign_in_required`,
`invite_not_found`, `invite_expired`, `invite_revoked`, `invite_accepted`,
`invite_email_mismatch`, `invite_exists`, `already_member`, `admins_full`, `last_admin`,
`sole_admin`, `internal`; `apiErrorSchema = { error: apiErrorCode, message: string, details?: unknown }`.

`src/api/auth.ts`: `otpRequestSchema {email: z.email(), captchaToken?: string}`;
`verifyRequestSchema = z.union([{email, code: /^\d{6}$/}, {tokenHash: string, type: literal('email')}])`;
`pkceExchangeRequestSchema {code, codeVerifier}`; `idTokenRequestSchema {provider: enum(apple,google), idToken, nonce?, accessToken?}`;
`refreshRequestSchema {refreshToken?: string}`; `signOutRequestSchema {scope: enum(local,global)}`;
`sessionUserSchema {id: uuid, email}`; `sessionResponseSchema {user, session: {createdAt, expiresAt, isFresh}, tokens?: {accessToken, refreshToken, expiresIn}}`;
`sessionsListResponseSchema {sessions: [{id, createdAt, lastActiveAt, deviceLabel, current}]}`;
`authConfigResponseSchema {providers: {apple: boolean, google: boolean}, turnstileSiteKey: string|null, termsVersion, privacyVersion}`.

`src/api/me.ts`: `profileSchema {userId, displayName, relationshipLabel|null, timezone, units, termsVersion|null, privacyVersion|null, acceptedAt|null}`;
`consentRequestSchema {termsVersion, privacyVersion, isAdult: boolean}`;
`profileUpdateSchema {displayName: trim 1..80, relationshipLabel: trim 1..40, timezone, units}` (all optional, at least one);
`meResponseSchema {user, profile|null, consent: {ok: boolean, requiredTermsVersion, requiredPrivacyVersion}, profileComplete: boolean, babies: babySummary[], session: {createdAt, isFresh}}`;
`deletionPreviewResponseSchema {blockingBabies: [{id,name}], babiesKept: [{id,name,otherAdminName}], freshSignIn: boolean}`;
`deleteAccountRequestSchema {acknowledge: literal(true)}`.

`src/api/babies.ts`: `babyCreateSchema {name 1..80, nickname?, birthDate: ISO date, birthDateIsDueDate?: boolean, birthWeightG?: int>0, birthLengthMm?: int>0}`;
`babyUpdateSchema` (partial of create); `babySchema {id, name, nickname, birthDate, birthDateIsDueDate, birthWeightG, birthLengthMm, avatarPhotoId, plan, role, createdAt, deletedAt}`;
`babySummarySchema {id, name, nickname, birthDate, plan, role}`; `babiesListResponseSchema {babies}`.

`src/api/members.ts`: `memberSchema {userId, displayName, relationshipLabel, role, joinedAt, removalRequestedBy|null, removalRequestedAt|null}`;
`memberRoleUpdateSchema {role: babyRole}`; `membersListResponseSchema {members, invites: inviteSchema[]}`.

`src/api/invites.ts`: `inviteCreateSchema {email: z.email(), role: babyRole}`;
`inviteSchema {id, email, role, expiresAt, createdAt, status: enum(pending,accepted,revoked,expired)}`;
`inviteLookupResponseSchema {status: enum(valid,expired,revoked,accepted), babyName, inviterName, role, maskedEmail, expiresAt}`;
`inviteAcceptResponseSchema {babyId, role}`.

`src/jwt-claims.ts`: `authenticatedClaimsSchema` gains `session_id: z.uuid()` (required; GoTrue
always sets it on user tokens).

`src/env.ts`: `authEnvSchema {AUTH_INTERNAL_URL: url default 'http://auth:9999', PUBLIC_URL: url,
AUTH_APPLE_ENABLED: stringbool default false, AUTH_GOOGLE_ENABLED: stringbool default false,
TURNSTILE_SECRET_KEY?: string, TURNSTILE_SITE_KEY?: string}`; `mailEnvSchema {SMTP_HOST,
SMTP_PORT: int default 587, SMTP_USER?, SMTP_PASS?, SMTP_SECURE: stringbool default false,
MAIL_FROM: z.email()}`. `index.ts` re-exports everything.

### 2.7 API internals (ownership-split interfaces)

`apps/api/src/plugins/db.ts` (backend-engineer) adds the low-level primitive:

```ts
export type DbRole = "authenticated" | "viewer" | "service_role";
export interface TxOptions { claimsJson?: string | null; dataKey?: string | null }
export async function runAs<T>(pool: pg.Pool, role: DbRole, opts: TxOptions,
  fn: (client: pg.PoolClient) => Promise<T>): Promise<T>
```
Exact mechanics: `client = pool.connect()`; `BEGIN`; `SET LOCAL ROLE <role>` with the role name
taken from a frozen map (never from input); if `claimsJson` → `SELECT set_config('request.jwt.claims', $1, true)`;
if `dataKey` → `SELECT set_config('app.data_key', $1, true)` (service_role only, step 5); `await fn(client)`;
`COMMIT`; on throw → `ROLLBACK` (its own error swallowed) and rethrow. `finally` (outside any
transaction): `RESET ROLE; DISCARD ALL`; if that fails → `client.release(err)` (destroyed), else
`client.release()`. Never `SET ROLE` without `LOCAL`; never log `claimsJson`/`dataKey`; pino must
not log query parameters. Test (3.10): with `max: 1`, after `runAs` (success and failure paths)
`SELECT current_user, current_setting('request.jwt.claims', true)` → `tinyglow_api`, `''`.

`apps/api/src/auth/index.ts` (security-engineer) exports what the rest of the API uses:

```ts
export interface AuthContext { claims: AuthenticatedClaims; uid: string; email: string | null;
  token: string; transport: "cookie" | "bearer"; clientKind: ClientKind; sessionId: string }
export interface TxContext { uid: string; email: string | null; sessionCreatedAt: Date; isFresh: boolean }
export function registerAuth(app: FastifyInstance, deps: { gotrue: GoTrueClient; mailer: Mailer; config: ApiConfig }): void
export const requireAuth: preHandlerHookHandler            // 401 unauthorized/token_expired
export function withClaims<T>(request, fn: (client, ctx: TxContext) => Promise<T>): Promise<T>  // runAs('authenticated'); auth_session_info ⇒ 401 session_revoked
export function withServiceRole<T>(app, reason: string, fn: (client) => Promise<T>, opts?: { dataKey?: boolean }): Promise<T>  // reason is required and logged at debug
export async function requireConsent(client, ctx): Promise<void>   // 403 consent_required
export function requireFreshSignIn(ctx): void                       // 403 fresh_sign_in_required
export async function audit(client, event, { babyId?, actorUserId, metadata? }): Promise<void>
```
`request.auth: AuthContext | null` is set by an `onRequest` hook: bearer header first, else the
`ll_access` cookie; `jose.jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'], issuer:
`${PUBLIC_URL}/auth`, audience: 'authenticated' })` then `authenticatedClaimsSchema.parse`;
expired ⇒ 401 `token_expired` (the SPA refreshes once and retries); cookie transport + non-GET
without `X-Tinyglow-Client: web` ⇒ 403 `csrf_rejected`. `GoTrueClient`
(`auth/gotrue.ts`) is an interface with a fetch implementation; `buildApp` accepts `gotrue?`
and `mailer?` stubs for tests. Bounded `withServiceRole` call sites (each with its reason):
invite lookup/accept by token hash; removal request writes; account deletion; nothing else in
this step.

`apps/api/src/email/` (backend-engineer): `Mailer { send(msg: {to, subject, html, text}): Promise<void> }`
with a nodemailer SMTP implementation (`mailEnvSchema`) and a `captureMailer()` for tests; logs
template name + message id only, never recipients or bodies. Templates (`email/templates.ts`,
HTML-escaped, no images/trackers): `inviteEmail({babyName, inviterName, role, acceptUrl,
expiresAt})` — subject `You're invited to ${babyName}'s album on Tinyglow`, body with the link
`${PUBLIC_URL}/invite/${token}` and "This invite expires in 7 days; accept it by signing in with
this email address"; `newDeviceEmail({when, deviceLabel, country, devicesUrl})` — subject `New
sign-in to your Tinyglow account`, link to `${PUBLIC_URL}/settings/devices`.

Account deletion (`auth/account.ts`), one `withServiceRole('account deletion')` transaction then
GoTrue: (1) `requireFreshSignIn`; (2) blocking babies = live babies where the user is the only
admin ⇒ 409 `sole_admin` ("Delete that album or promote a co-admin first"); (3) audit
`account.deleted` (actor = user; becomes NULL after cascade); (4) `UPDATE profiles SET deleted_at
= now()`; (5) commit; (6) GoTrue `DELETE /admin/users/{id}` (hard delete: cascades sessions,
identities, profile → memberships; `babies.plan_owner_user_id` SET NULL → plan reverts by
trigger; `photos.uploaded_by` SET NULL so the remaining admin keeps the photos); (7) clear
cookies, 204. Babies the user had soft-deleted are purged after 30 days by the worker's
`purge.trash` job (name reserved now, implemented in step 4 together with object deletion).

### 2.8 GoTrue, nginx, Vite, env (devops-engineer)

| Item | Dev (`docker-compose.dev.yml`, `.env.dev`) | Prod (`docker-compose.yml`, `.env.example`) |
| --- | --- | --- |
| `auth` env | add `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true"`, `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: "10"`, `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT: "2160h"`, `GOTRUE_SESSIONS_SINGLE_PER_USER: "false"`, `GOTRUE_EXTERNAL_PHONE_ENABLED: "false"`, `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"`, `GOTRUE_RATE_LIMIT_HEADER: X-Forwarded-For` (the API forwards the client IP); Apple/Google stay `"false"` (dev OAuth testing: pass `GOTRUE_EXTERNAL_GOOGLE_ENABLED` etc. in the shell; documented) | same additions; `GOTRUE_SMTP_MAX_FREQUENCY: 60s`, `GOTRUE_RATE_LIMIT_EMAIL_SENT: "200"` (global per-hour backstop; per-email/IP limits live in the API); `GOTRUE_RATE_LIMIT_HEADER` stays `CF-Connecting-IP` |
| Email templates | `docker/gotrue/templates/{confirmation,magic-link}.html`: keep the 6-digit `{{ .Token }}` as primary; the fallback link becomes `{{ .SiteURL }}/signin/callback#token_hash={{ .TokenHash }}&type=email` (no `{{ .ConfirmationURL }}`); text says "on a computer, open this link" | same files |
| `api` env | `PUBLIC_URL=http://localhost:8080`, `AUTH_INTERNAL_URL=http://auth:9999`, `AUTH_APPLE_ENABLED=false`, `AUTH_GOOGLE_ENABLED=false`, `SMTP_HOST=mail`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `MAIL_FROM=noreply@tinyglow.local` in `.env.dev` (`TURNSTILE_*` absent) | api block: `AUTH_INTERNAL_URL: http://auth:9999`, `AUTH_APPLE_ENABLED: ${GOTRUE_EXTERNAL_APPLE_ENABLED:-false}`, `AUTH_GOOGLE_ENABLED: ${GOTRUE_EXTERNAL_GOOGLE_ENABLED:-false}` (one `.env` flag feeds GoTrue and the API), `SMTP_HOST/PORT/USER/PASS/SECURE`, `MAIL_FROM: ${MAIL_FROM:-${SMTP_ADMIN_EMAIL}}`, `TURNSTILE_SECRET_KEY: ${TURNSTILE_SECRET_KEY:-}`, `TURNSTILE_SITE_KEY: ${TURNSTILE_SITE_KEY:-}`. Update the header comment: api now receives SMTP; worker still does not |
| `.env.example` | – | document `GOTRUE_EXTERNAL_APPLE_ENABLED`, `APPLE_CLIENT_ID` (comma list: Services ID for web, bundle ID for native), `APPLE_CLIENT_SECRET` (6-month JWT from the .p8 key; regenerate before expiry), `GOTRUE_EXTERNAL_GOOGLE_ENABLED`, `GOOGLE_CLIENT_ID` (comma list: web, iOS, Android), `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `MAIL_FROM`, `SMTP_SECURE`; redirect URI to register at both providers: `https://tinyglow.app/auth/callback` |
| nginx `/auth/` | – | only `= /auth/health` (GET), `= /auth/authorize` (GET), `= /auth/callback` (GET, POST) proxy to GoTrue (prefix stripped, same headers as today); `location /auth/ { return 404; }` |
| Vite proxy (frontend-engineer, `vite.config.ts`) | `/auth` proxy gets `bypass` returning `false` (404) unless the path is one of the three above | – |
| `api` Dockerfile / compose | `apps/api/Dockerfile` dev stage `COPY packages/db packages/db` (the API imports `@tinyglow/db/types`, type-only); dev compose bind-mounts `./packages/db/src:/repo/packages/db/src:ro` into `api` | prod stage unchanged (tsup bundles types away) |
| CI | `dev-stack-smoke` job: after the stack is up, `pnpm install --frozen-lockfile`, `pnpm exec playwright install --with-deps chromium`, `pnpm e2e` (then the existing smoke); upload `e2e/report` on failure. `check` job: `pnpm test:integration` now also runs the `api-integration` project (env adds `JWT_SECRET=dev-only-jwt-secret-at-least-32-characters`, `PUBLIC_URL=http://localhost:8080`, `MAIL_FROM=noreply@tinyglow.local`, `SMTP_HOST=localhost`) | – |

### 2.9 Rate limits, captcha, generic responses (security-engineer, `auth/throttle.ts`, `auth/turnstile.ts`)

In-memory sliding windows (one API instance; documented limitation, see R5): OTP requests
5/h per email and 30/h per IP; verify attempts 5 per email per 10 min; invite lookups 60/h per
IP; a 429 carries `Retry-After` and code `rate_limited`. Turnstile: when `TURNSTILE_SECRET_KEY`
is set and an IP has requested ≥ 3 codes in the hour, `POST /auth/otp` without a valid
`captchaToken` (verified at `https://challenges.cloudflare.com/turnstile/v0/siteverify`,
`remoteip` = client IP) returns 403 `captcha_required`; a bad token 403 `captcha_failed`. Without
the secret the threshold is inert (dev, CI). `POST /auth/otp` never reveals whether an account
exists (always 202; UI text "If this email is valid, we sent a code").

### 2.10 Frontend (frontend-engineer, `apps/mobile-web/src/**`)

- `lib/api.ts`: `apiFetch(path, init)` → JSON, `credentials: 'same-origin'`, header
  `X-Tinyglow-Client` from `platform.ts` (`'web'` now; step 9 returns `'native'` and attaches
  the bearer token from `tokenStore.ts`); on 401 `token_expired` → `POST /api/auth/refresh` once
  then retry; other 401 → clear auth state → `/welcome`. Errors become `ApiError {status, code,
  message, details}` (`apiErrorSchema`).
- `platform/platform.ts` (`isNative(): false`), `platform/tokenStore.ts` (`TokenStore {get, set,
  clear}`; web implementation is a no-op because cookies are server-managed) — the step-9 seam.
- `auth/AuthProvider.tsx` (TanStack Query `['me']` → `GET /api/me`), `useAuth()`, `useCurrentBaby()`
  (`currentBabyId` in localStorage, validated against `me.babies`, falls back to the first),
  `RequireAuth`/`RequireOnboarded` guards, `nextOnboardingRoute(me, pendingInvite)`.
- Routes (react-router 6 inside `IonReactRouter`): public `/welcome`, `/verify`,
  `/signin/callback`, `/invite/:token`, `/legal/terms`, `/legal/privacy`; onboarding
  `/onboarding/consent`, `/onboarding/profile`, `/onboarding/baby`, `/onboarding/invite`,
  `/onboarding/plan`, `/onboarding/first-upload`; app (tabs, guarded) `/chat`, `/timeline`,
  `/upload`, `/milestones`, `/family` (members, invites, leave), `/settings`, `/settings/devices`,
  `/settings/account`. `/` → `/chat` when onboarded, else the next onboarding route or `/welcome`.
- Screens (PRD sign-up flow 1–8): **Welcome** (Apple/Google buttons only when
  `GET /api/auth/config` enables them; email field; "If this email is valid, we sent a code");
  **Verify** (single `<input inputMode="numeric" autoComplete="one-time-code" maxLength=6>`,
  paste and autofill supported, auto-submit at 6 digits, resend with 60 s cooldown, Turnstile
  widget rendered only on `captcha_required` using the site key from `/api/auth/config`;
  magic-link landing handled by `/signin/callback` reading `#token_hash` or `?code` + PKCE
  verifier from sessionStorage); **Consent** (checkbox text exactly "I'm 18 or older and agree to
  the Terms and Privacy Policy", links to the legal pages, unchecked ⇒ cannot continue;
  `isAdult:false` never sent); **Profile** (display name, relationship chips from
  `RELATIONSHIP_LABELS` + free text, timezone auto from `Intl`, units); **Fork** (pending invite
  token in sessionStorage `ll_pending_invite` ⇒ accept and land in that album; else **Create your
  baby**: name, birth date or due date toggle, optional weight/length; photo is step 4); **Invite
  co-parent** (skippable; email → `POST /babies/:id/invites {role:'admin'}`); **Plan** (free by
  default; "Plus, $3.99/month: AI descriptions, search and chat" with a disabled "Upgrade, coming
  soon" button; no payments this step); **First upload** primer (permission explanation + "Choose
  photos" → `/upload`; marks `onboardingDone:<babyId>` in localStorage).
- **Invite accept** `/invite/:token`: `GET /api/invites/:token` → "{inviter} invited you to
  {baby}'s album as {role}"; not signed in ⇒ store the token, go to `/welcome`; signed in and
  onboarded ⇒ `POST /api/invites/:token/accept`; `invite_email_mismatch` ⇒ show the server
  message verbatim ("This invite was sent to m***@gmail.com") with "Sign out and use that email";
  `admins_full` ⇒ "This album already has two admins"; expired/revoked ⇒ "Ask the parents for a
  new invite".
- **Header** `AppHeader` on every tab page with the **baby switcher** (IonSelect/popover over
  `me.babies`, "Add another baby" → `/onboarding/baby?another=1`) and a settings link.
- **Settings**: devices (`GET /api/auth/sessions`, per-row "Sign out", "Sign out everywhere");
  account ("Delete account": preview → blocking albums with "Delete album"/"Promote co-admin"
  guidance → re-verify by email code (`/verify` in reauth mode) → consequences screen → confirm →
  `DELETE /me` → `/welcome`). A reusable `FreshSignInGate` handles 403 `fresh_sign_in_required`
  (re-verify then retry) for delete baby / remove co-admin / confirm removal.
- Family tab: members list with roles, remove (contributor: immediate; co-admin: "requires their
  confirmation" → request), pending removal banner for the target (Confirm/Decline), leave album,
  invite (admin/contributor), pending invites with resend/revoke.
- Accessibility/UX (PRD): 44 px targets, labels for every input, VoiceOver-friendly code input,
  dark mode via Ionic, strings in `i18n/en.ts` behind a tiny `t()` (localization-ready).
- `SystemStatus` keeps polling `/api/healthz` and `/auth/health` (both still allowed).

### 2.11 e2e (test-engineer, `e2e/**`)

Playwright (`@playwright/test`, root devDependency) against the running dev stack:
`e2e/playwright.config.ts` (baseURL `http://localhost:8080`, Chromium, 375×812 viewport,
`workers: 1`, retries 1 in CI, HTML report to `e2e/report`), `e2e/helpers/mailpit.ts`
(`latestCodeFor(email)`, `inviteLinkFor(email)` via `GET /api/v1/search?query=to:…` +
`GET /api/v1/message/:id`, regex `/\/invite\/([A-Za-z0-9_-]{43})/`), `e2e/helpers/api.ts`
(cookie-jar `fetch` with the client header for API-level assertions). Specs in `e2e/auth/`:
`onboarding.spec.ts` (sign up → code → consent → profile → create baby → invite co-admin → skip
plan → primer → timeline shows the baby in the switcher), `invite.spec.ts` (new context: invitee
opens the Mailpit link, signs in with the invited email, lands in the album; members list has 2
admins; a different email on another invite link sees "This invite was sent to o***@example.com"
and the API returns 403 `invite_email_mismatch`; a third admin invite accept ⇒ 409 `admins_full`),
`sessions.spec.ts` (devices list; sign out everywhere ⇒ `GET /api/me` 401), `account.spec.ts`
(sole admin blocked ⇒ delete album ⇒ delete account ⇒ 401; co-admin deletion keeps the album for
the other admin), `seed.spec.ts` (`demo-mom@tinyglow.local` signs in with OTP and sees Maya as
admin — step-2 risk R1). Root script `"e2e": "playwright test -c e2e/playwright.config.ts"`.

## 3. Tasks

Owners per `CLAUDE.md`. Lanes: D = devops, B = backend, S = security, F = frontend, T = test.
Same-lane tasks run in sequence; lanes run in parallel where noted.

### 3.1 Dependencies, root scripts, vitest projects (devops-engineer) — first, alone (serial lockfile change)

- Owned for this task only (orchestrator approval implied by this plan): every `package.json`,
  `pnpm-lock.yaml`, root `vitest.config.ts`, `apps/api/Dockerfile`, dev compose `api` bind mount.
- Add: `apps/api`: `jose`, `@fastify/cookie`, `nodemailer`, `@tinyglow/db: workspace:*`;
  devDependency `@types/nodemailer`. Root devDependency `@playwright/test`. No frontend deps.
  Pin exact versions (latest stable passing pnpm's minimum-release-age), one `pnpm install`.
- Root scripts: `"e2e": "playwright test -c e2e/playwright.config.ts"`, `"test:integration":
  "vitest run --project db-integration --project api-integration"`. `vitest.config.ts`: add
  project `api-integration` (root `./apps/api`, include `**/*.integration.test.ts`, node env,
  `fileParallelism: false`, 60 s timeouts); `apps/api` `test` script excludes
  `**/*.integration.test.ts`. Dockerfile/compose per 2.8 last row.
- Done-when: `pnpm install --frozen-lockfile` is a no-op; `pnpm lint && pnpm typecheck && pnpm
  test` green; `docker compose -f docker-compose.dev.yml build api` succeeds.

### 3.2 Shared contracts (backend-engineer) — lane B, after 3.1

- Owned: `packages/shared/src/**` (new `auth.ts`, `api/{errors,auth,me,babies,members,invites}.ts`,
  edits to `jwt-claims.ts`, `env.ts`, `index.ts`).
- Build 2.6 literally (names, codes, constants, the exact mismatch message helper). Only `zod`.
- Done-when: typecheck passes; `maskEmail`, `normalizeEmail`, `userAgentLabel`, error-code enum
  and schema unit tests (3.10) can be written against it.

### 3.3S Migration, stub, generated types (security-engineer) — lane S, after 3.1 (parallel with 3.2)

- Owned: `packages/db/migrations/1791600000100_auth-sessions-and-plan.sql`,
  `packages/db/src/test-support.ts`, `packages/db/src/generated/**`, `packages/db/README.md`.
- Build 2.5. Security notes to write into the SQL: functions are the only access path to
  `auth.*` (no `GRANT` on `auth` tables to any app role), every function filters by `auth_uid()`,
  `REVOKE EXECUTE FROM PUBLIC`; the removal columns are `service_role`-written; RLS stays
  ENABLE+FORCE on `baby_members` (the hardening check in 5.6 must still return 0).
- Done-when: `pnpm db:migrate` on the dev stack applies 10 migrations total, second run no-op,
  `pnpm db:migrate:down 1 && pnpm db:migrate` round-trips; against a bare DB with only the stub,
  migrations apply (stub has `auth.sessions`); `pnpm db:types` committed with no diff on re-run;
  README documents the session functions and the plan-follows-owner rule.

### 3.3 API foundation (backend-engineer) — lane B, after 3.2

- Owned: `apps/api/src/plugins/db.ts` (`runAs`), `apps/api/src/lib/errors.ts` (`ApiError`,
  `mapPgError`, global error handler), `apps/api/src/lib/request.ts` (`clientIp`,
  `clientCountry`, `clientKind`), `apps/api/src/email/{mailer,templates}.ts`,
  `apps/api/src/config.ts` (adds `authEnvSchema`, `mailEnvSchema`), `apps/api/src/app.ts`
  (`trustProxy: true`, register `@fastify/cookie`, mailer, GoTrue client injection, call
  `registerAuth` from `./auth` and the route modules; `buildApp({config, db?, s3?, gotrue?, mailer?})`).
- Not owned: anything under `apps/api/src/auth/**`. `app.ts` imports `registerAuth`,
  `createGoTrueClient` from `./auth` per the 2.7 signatures; until 3.4 lands, typecheck is
  expected to fail on that import (orchestrator runs 3.3 and 3.3S/3.4 so that 3.4 follows 3.3).
- Done-when: `runAs` behaves per 2.7 (the 3.10 test), error handler returns `apiErrorSchema`
  bodies with no SQL/parameter leakage, mailer sends through Mailpit from the dev stack
  (`docker compose exec api node -e …` or a unit test with a captured transport), config fails
  fast with field names only.

### 3.4 Auth core (security-engineer) — lane S, after 3.3S and 3.3

- Owned: `apps/api/src/auth/{index,plugin,context,gotrue,session,routes,sessions,throttle,turnstile,admin-jwt}.ts`.
- Build 2.2, 2.3, 2.7 (`registerAuth`, `requireAuth`, `withClaims`, `withServiceRole`,
  `requireConsent`, `requireFreshSignIn`, `audit`), the `/auth/*` routes of 2.4, 2.9. Explicit
  requirements: JWT verified with `JWT_SECRET`, issuer `${PUBLIC_URL}/auth`, HS256 only; tokens,
  claims, codes, cookies never logged (pino redact already covers headers; add `req.body.code`,
  `req.body.tokenHash`, `req.body.refreshToken`, `req.body.idToken`, `req.body.captchaToken`);
  cookie attributes exactly as 2.2; CSRF header check; `withClaims` calls `auth_session_info`
  first and throws 401 `session_revoked` on no row; `withServiceRole` requires a non-empty
  `reason`; generic 202 on `/auth/otp`; the GoTrue client forwards `X-Forwarded-For`,
  `CF-Connecting-IP`, `User-Agent`; the `service_role` admin JWT is minted per call with a 60 s
  expiry and never persisted.
- Done-when: on the dev stack the curl sequence in 4.2 steps 1–5 works (otp → Mailpit code →
  verify sets both cookies → `GET /me` 200 → `POST /auth/signout` → `GET /me` 401); 6th code
  request for one email within the hour ⇒ 429; a `DELETE /auth/sessions/:id` of another device
  makes that device's next request 401 `session_revoked`.

### 3.5 Invites, members, account deletion (security-engineer) — lane S, after 3.4

- Owned: `apps/api/src/auth/{invites,members,account}.ts`.
- Build the invite, member and account rows of 2.4 and the deletion sequence in 2.7. Explicit
  requirements: 256-bit token, hashed at rest, never returned by any endpoint or log; email
  matching case-insensitive via `normalizeEmail`; mismatch message exactly `This invite was sent
  to ${maskEmail(email)}`; two-admin and rate-limit errors come from the step-2 triggers and are
  mapped (not re-implemented); removal of a co-admin always goes through the target's
  confirmation; fresh sign-in on leave/confirm/delete; the plan reverts when the paying admin
  leaves or is deleted (trigger; assert in a test); audit events for every action with
  metadata per the 2.6 rule.
- Done-when: 4.2 steps 6–10 pass by hand (invite email in Mailpit with the link; matching email
  accepts; mismatch 403 with the exact message; third admin 409 `admins_full`; sole-admin
  deletion blocked then succeeds after deleting the album, and `GET /me` is 401 afterwards).

### 3.6 Me, babies, healthz (backend-engineer) — lane B, after 3.4

- Owned: `apps/api/src/routes/{me,babies,healthz}.ts`.
- Build the `/me`, `/babies` and `/healthz` rows of 2.4 using `withClaims`, `requireConsent`,
  `requireFreshSignIn`, `audit`. Every query names its columns (step-2 column grants). Consent
  stores `accepted_ip_country` from `clientCountry`; `isAdult:false` ⇒ 403 `under_18`, nothing
  stored. `GET /me` must be a single transaction. Production `/healthz` detail only for loopback.
- Done-when: 4.2 steps 3–5 (consent, profile, create baby, list) pass; `PATCH /babies/:id` of a
  non-member ⇒ 404 (RLS returns no row); `DELETE /babies/:id` without fresh sign-in ⇒ 403
  `fresh_sign_in_required`; unit test shows prod `/healthz` from a non-loopback address returns
  only `{status}`.

### 3.7 Frontend (frontend-engineer) — lane F, after 3.2 (parallel with S and B; integrates once 3.4–3.6 are up)

- Owned: `apps/mobile-web/src/**`, `apps/mobile-web/vite.config.ts` (proxy allow-list, 2.8).
- Build 2.10. Security notes: never store tokens in localStorage/sessionStorage on web (cookies
  only); the PKCE verifier and the pending invite token live in sessionStorage and are removed
  after use; the Turnstile script is loaded only when needed; no third-party scripts otherwise;
  `currentBabyId` is the only persisted app state.
- Done-when: `pnpm --filter @tinyglow/mobile-web typecheck && test` green; against the dev
  stack a human can complete steps 1–8, open an invite link, switch babies, list devices, and
  delete the account; the e2e in 3.12 drives the same screens by `data-testid`s listed in the
  component files (`welcome-email`, `welcome-continue`, `verify-code`, `consent-adult`,
  `consent-continue`, `profile-name`, `baby-name`, `baby-birthdate`, `invite-email`,
  `invite-send`, `plan-skip`, `primer-continue`, `baby-switcher`, `invite-accept`,
  `invite-mismatch`, `devices-signout-all`, `account-delete`).

### 3.8 Compose, env, GoTrue, templates, nginx (devops-engineer) — lane D, after 3.1 (parallel with S/B/F)

- Owned: `docker-compose.dev.yml`, `docker-compose.yml`, `.env.dev`, `.env.example`,
  `docker/gotrue/templates/*`, `docker/nginx/default.conf`.
- Build 2.8 (all rows except CI). Keep zero-setup dev; no new files for the user; least
  privilege (api gets SMTP, worker does not; `auth` gets no API secrets); `.env.example`
  placeholders only with the exact credential names in section 5 "Needs the user".
- Done-when: both `docker compose … config -q` pass; from a clean clone `up -d --build --wait`
  is healthy; `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8080/auth/otp` is `404`
  in dev (Vite, after 3.7) and the nginx image returns 404 for the same path while
  `/auth/health` is 200; the magic-link email in Mailpit contains `/signin/callback#token_hash=`.

### 3.9 Worker job name reservation (backend-engineer) — lane B, trivial, with 3.6

- Owned: `apps/worker/src/jobs.ts` (new): `export const JOBS = { purgeTrash: 'purge.trash' } as const`
  with a comment that step 4 implements it (hard-delete `babies`/`photos` trashed > 30 days,
  including MinIO object versions). No handler yet.
- Done-when: typecheck passes.

### 3.10 Unit and integration tests (test-engineer) — lane T, after 3.3–3.6

- Owned: `**/*.test.ts`, `packages/db/test/{harness,fixtures}.ts`.
- Files: `packages/shared/src/{auth,api/*}.test.ts` (maskEmail incl. one-char local part,
  normalizeEmail, error codes, audit metadata rule, `session_id` required in claims);
  `apps/api/src/plugins/db.integration.test.ts` (**the step-2 open issue**: with a `max: 1`
  pool, after `runAs` success and after `fn` throws, `SELECT current_user` is `tinyglow_api`
  and `current_setting('request.jwt.claims', true)` is empty; a client that fails `DISCARD ALL`
  is destroyed); `apps/api/src/auth/*.test.ts` (JWT verify: wrong secret/issuer/alg/expired ⇒
  401 codes; cookie attributes; CSRF header; throttle windows; Turnstile threshold inert without
  secret; GoTrue stub; service_role admin JWT shape; `withServiceRole` without reason throws);
  `apps/api/src/auth/{invites,members,account}.integration.test.ts` and
  `apps/api/src/routes/{me,babies}.integration.test.ts` (DB via the stub + `auth.sessions` rows,
  tokens minted with `jose` and `JWT_SECRET`, GoTrue and mailer stubs: full invite matrix incl.
  the exact mismatch message, `admins_full`, revoke/resend/expiry, removal request flow,
  last-admin, plan reverts on owner removal, sole-admin deletion block, consent gates, under_18,
  fresh-sign-in gates); `packages/db/triggers.integration.test.ts` additions (session functions
  filter by `auth_uid()`; plan-follows-owner on member delete and on `auth.users` cascade);
  `apps/api/src/email/templates.test.ts` (escaping, link format).
- Done-when: `pnpm test` and `pnpm test:integration` green locally against the dev stack and
  against a bare pgvector (stub path, as CI).

### 3.11 Smoke update (test-engineer) — lane T, with 3.10

- Owned: `e2e/smoke/dev-stack.sh`.
- Step 4 posts to `/api/auth/otp` (direct `/auth/otp` is now 404; add an assertion for that);
  step 1 ordering unchanged; add "migrate applied 10 migrations" via `pgmigrations` count.
- Done-when: `pnpm smoke` green.

### 3.12 e2e (test-engineer) — lane T, after 3.7, 3.8, 3.10

- Owned: `e2e/playwright.config.ts`, `e2e/helpers/**`, `e2e/auth/*.spec.ts`.
- Build 2.11. Unique emails per run (`e2e-<ts>-<rand>@example.com`); never assert on secrets;
  the invite token is used only to navigate.
- Done-when: `pnpm e2e` green twice in a row against the dev stack; total runtime < 4 min.

### 3.13 CI (devops-engineer) — lane D, after 3.12

- Owned: `.github/workflows/ci.yml`.
- Build the CI row of 2.8. Done-when: `actionlint` clean; the job commands pass locally
  (`pnpm e2e` after `up --wait`).

### Parallelism summary

| Group | Tasks | Notes |
| --- | --- | --- |
| 0 (serial) | 3.1 | lockfile + root config |
| 1 (parallel) | 3.2 (B) · 3.3S (S) · 3.8 (D) | disjoint paths |
| 2 (parallel) | 3.3 (B, after 3.2) · 3.7 (F, after 3.2) | 3.3S may still be running |
| 3 (serial) | 3.4 (S, after 3.3S and 3.3) | the API does not typecheck until this lands |
| 4 (parallel) | 3.5 (S) · 3.6 + 3.9 (B) · 3.7 continues (F) | disjoint paths |
| 5 (parallel) | 3.10 + 3.11 (T) | after 3.5, 3.6 |
| 6 (serial) | 3.12 (T) → 3.13 (D) | needs 3.7, 3.8 |
| Gate | orchestrator | section 4 |

ai-engineer and mobile-engineer have no step-3 work (native auth, secure storage and deep links
are step 9; the seams are `platform/`, `tokenStore.ts`, `/signin/callback`, `/invite/:token`,
`POST /api/auth/id-token`).

## 4. Acceptance checks

Verbatim, PRD step 3: "Check: e2e test signs up, creates a baby, invites a co-admin, and the
invitee accepts with the matching email; mismatched email is rejected." Run from the repo root
with Docker Desktop running.

### 4.1 The PRD check

```sh
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d --build --wait
pnpm install --frozen-lockfile && pnpm exec playwright install chromium
pnpm e2e        # onboarding, invite (match + mismatch + admins_full), sessions, account, seed specs green
```

### 4.2 API walkthrough (cookie jar; `B=http://localhost:8080`, `M=http://localhost:8025`, `H='x-tinyglow-client: web'`)

1. `curl -s -X POST $B/api/auth/otp -H 'content-type: application/json' -H "$H" -d '{"email":"a@example.com"}'` → `202 {"ok":true}`; same for a 6th call within the hour → `429` with `Retry-After`.
2. Code: `ID=$(curl -s "$M/api/v1/search?query=to:a@example.com" | jq -r '.messages[0].ID'); CODE=$(curl -s $M/api/v1/message/$ID | jq -r .Text | grep -oE '[0-9]{6}' | head -1)`.
3. `curl -si -c a.jar -X POST $B/api/auth/verify -H 'content-type: application/json' -H "$H" -d "{\"email\":\"a@example.com\",\"code\":\"$CODE\"}"` → 200; `Set-Cookie: ll_access=…; Path=/api; HttpOnly; SameSite=Lax` and `ll_refresh=…; Path=/api/auth; HttpOnly; SameSite=Strict`; body has no `tokens`.
4. `curl -s -b a.jar $B/api/me` → `consent.ok=false`, `babies=[]`; `curl -s -b a.jar -X POST $B/api/babies …` → 403 `consent_required`; `POST /api/me/consent {"termsVersion":"2026-10-08","privacyVersion":"2026-10-08","isAdult":false}` → 403 `under_18`; with `true` → 200; `PATCH /api/me/profile {"displayName":"Maria","relationshipLabel":"Mom"}` → 200.
5. `POST /api/babies {"name":"Maya","birthDate":"2025-06-30"}` → 201 with `role:"admin"`; `GET /api/babies` lists it.
6. `POST /api/babies/<id>/invites {"email":"B@Example.com","role":"admin"}` → 201, body has no token; Mailpit has a mail to `b@example.com` whose body contains `http://localhost:8080/invite/<43 chars>`; a second identical invite → 409 `invite_exists`.
7. `curl -s $B/api/invites/<token>` (no auth) → `status:"valid"`, `maskedEmail:"b***@example.com"`.
8. Sign in `b@example.com` (steps 1–4 with `b.jar`), then `POST /api/invites/<token>/accept` → 200 `{babyId, role:"admin"}`; `GET /api/babies/<id>/members` → 2 admins; the same token again → 410 `invite_accepted`.
9. Sign in `c@example.com` (`c.jar`); invite `d@example.com` from `a.jar`; `POST /api/invites/<token-d>/accept` with `c.jar` → `403 {"error":"invite_email_mismatch","message":"This invite was sent to d***@example.com"}`.
10. Invite `e@example.com` as admin from `a.jar`, sign in `e@example.com`, accept → 409 `admins_full`.
11. `GET /api/auth/sessions` with `a.jar` → ≥1 session with `current:true`; `POST /api/auth/signout {"scope":"global"}` → 204; `GET /api/me` → 401.
12. Account deletion: with `c.jar` (sole admin of nothing) `DELETE /api/me {"acknowledge":true}` → 204, then `GET /api/me` → 401. With `b.jar` (co-admin of Maya): fresh sign-in then delete → 204; `a.jar` still sees Maya with one admin.
13. Direct GoTrue blocked: `curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/otp` → 404; `$B/auth/health` → 200.
14. CSRF: a cookie-authenticated `POST /api/babies` without the `x-tinyglow-client` header → 403 `csrf_rejected`.

### 4.3 Suites and hygiene

```sh
pnpm lint && pnpm typecheck && pnpm test
DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow AUTH_DB_PASSWORD=dev API_DB_PASSWORD=dev \
WORKER_DB_PASSWORD=dev DATA_ENCRYPTION_KEY=dev-only-data-encryption-key-32-chars-min SEED_DEMO_FAMILY=true \
JWT_SECRET=dev-only-jwt-secret-at-least-32-characters PUBLIC_URL=http://localhost:8080 \
MAIL_FROM=noreply@tinyglow.local SMTP_HOST=localhost pnpm test:integration   # incl. db.integration.test.ts: current_user = tinyglow_api after runAs
pnpm smoke
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d tinyglow -Atc "select count(*) from pgmigrations"   # 10
docker compose -f docker-compose.dev.yml exec -T db psql -U postgres -d tinyglow -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname<>'pgmigrations' and not (c.relrowsecurity and c.relforcerowsecurity)"   # 0
docker compose -f docker-compose.dev.yml logs api | grep -Ei 'll_access=|ll_refresh=|"code":"[0-9]{6}"|token_hash=' ; echo "no secrets in logs: exit $?"   # expect no match (exit 1)
grep -rn 'change-me' .env.dev; git status --porcelain | grep -E '^\?\? \.env(\.local)?$'   # nothing
cp .env.example .env && STORAGE_PATH=/tmp/s BACKUP_PATH=/tmp/b docker compose -f docker-compose.yml config -q; rm .env
```

## 5. Risks and decisions (orchestrator to confirm or override)

- **D1 — No supabase-js; the API is GoTrue's only client.** The PRD's "`@supabase/ssr` pattern"
  is realised by our Fastify API exchanging codes/tokens with GoTrue over the internal network
  and storing web sessions in httpOnly cookies; browser-facing GoTrue is limited to the OAuth
  redirect endpoints (nginx/Vite 404 the rest). Gains: per-email/IP limits, Turnstile, generic
  responses, audit, CSRF and cookie policy in one place; no password endpoints reachable.
  Cost: our own thin GoTrue client (~150 lines). Alternative: supabase-js with localStorage
  (violates the PRD's cookie/Keychain rules).
- **D2 — Session liveness and devices via SECURITY DEFINER functions over `auth.sessions`.**
  GoTrue has no "list/revoke another device" endpoint, and a stateless 1-hour JWT would make
  per-device sign-out and account deletion lag. One primary-key lookup per request buys
  immediate revocation. Coupling: `auth.sessions` columns of `supabase/auth:v2.197.0` (stable
  since 2022); the migration guards their existence and the CI stub mirrors them. No grants on
  `auth.*` are given to any role.
- **D3 — Fresh sign-in = GoTrue session age ≤ 10 min**; re-verification creates a new session and
  logs out the old one locally. Simple, and it doubles as the "re-verify by email code" for
  account deletion.
- **D4 — FR-1.5 reading.** "Removing an admin requires the other admin's confirmation" is
  implemented as: the admin being removed must confirm (or initiates it by leaving). Stored as
  two `service_role`-written columns on `baby_members`, 7-day validity; the last-admin trigger
  still protects. Alternative: no request state, admins can only leave, never remove the other.
- **D5 — Plan reverts to `free` when the paying admin leaves or is deleted** (step-2 open issue),
  enforced by triggers so every path (API, FK cascade) agrees. Existing photos stay; AI stops.
- **D6 — Account deletion is an immediate GoTrue hard delete** (cascades everything personal);
  "within 30 days" covers only soft-deleted babies purged by the step-4 `purge.trash` job and
  step-6 provider batch files. Alternative: GoTrue soft delete with a 30-day recovery window
  (more state, more support surface).
- **D7 — New dependencies**: `jose` (JWT verify + admin JWT mint; also step-8 viewer JWTs),
  `@fastify/cookie`, `nodemailer` + types (SMTP works with Mailpit and Postmark/Resend alike; a
  provider HTTP API would need a second dev path), `@playwright/test` (the PRD asks for an e2e;
  this is the standard browser runner and reads Mailpit over HTTP), `@tinyglow/db` as a
  type-only API dependency. Rate limiting is an in-house sliding window (R5) rather than
  `@fastify/rate-limit`, which keys on one dimension per route.
- **D8 — Magic link carries `token_hash` in the URL fragment** to `/signin/callback` and the API
  verifies it; the SPA callback route is `/signin/callback` because `/auth/*` is proxied to GoTrue.
  Step 9's universal links add `/signin/*` and `/invite/*` to AASA/assetlinks.
- **D9 — Invite emails are sent by the API over SMTP** (`SMTP_*` shared with GoTrue, plus
  `MAIL_FROM`); the PRD's `POSTMARK_TOKEN`/`RESEND_API_KEY` stay unused (comment in `.env.example`).
- **D10 — New-device alert email is in scope** (small once the mailer and session functions
  exist); "new device" = another live session existed at sign-in time.
- **D11 — Terms/Privacy pages are placeholders** with version `2026-10-08`; the e2e consent step
  does not depend on their wording. Real legal copy is needed before launch (user).
- **R1 — SQL-seeded GoTrue users** (step-2 R1) are proven by `seed.spec.ts`. If GoTrue rejects
  them (typically NULL scans in token/flag columns), security-engineer extends the inserted column
  set; last resort: create them through `POST /admin/users` from the seed when `AUTH_INTERNAL_URL`
  is reachable (fixed ids require GoTrue's admin create to accept `id`; verify before relying on it).
- **R2 — GoTrue behaviour assumptions**: `POST /verify {type:"email"}` accepts both the 6-digit
  token and `token_hash` for signup and magic-link emails; `.TokenHash`/`.SiteURL` exist in
  templates; `session_id` is always in user JWTs; the admin API accepts an HS256 JWT with
  `role: service_role`; `X-Forwarded-For` is honoured for session IP and rate limits. All are
  exercised by 4.2 on `v2.197.0`; a mismatch is a 3.4 fix, not a design change.
- **R3 — Apple/Google untested end-to-end** until credentials exist; the PKCE and id-token
  paths are unit-tested against a GoTrue stub only. Apple web OAuth does not work on
  `localhost`; Google does (`http://localhost:8080/auth/callback`).
- **R4 — Playwright in CI** adds ~3 min and a browser download to `dev-stack-smoke`; flakiness
  is bounded by `workers: 1`, unique emails and Mailpit polling with timeouts.
- **R5 — In-memory rate limits** reset on API restart and do not aggregate across replicas;
  acceptable for one API container (prod compose runs one). Move to a Postgres table if the API
  is ever scaled; GoTrue's global email cap is the backstop meanwhile.
- **R6 — `DISCARD ALL` on every release** costs a round trip; negligible at this scale and it is
  the only way to guarantee no role/claims leakage across pooled requests.
- **Needs the user (not for the gate; add to `.env` on the server when available):**
  1. Apple: Apple Developer App ID (bundle id, Sign in with Apple capability), a Services ID for
     web with return URL `https://tinyglow.app/auth/callback`, a Sign in with Apple
     key (.p8) + Key ID + Team ID → `APPLE_CLIENT_ID=<services id>,<bundle id>`,
     `APPLE_CLIENT_SECRET=<ES256 client-secret JWT, max 6 months, regenerate on expiry>`,
     `GOTRUE_EXTERNAL_APPLE_ENABLED=true`.
  2. Google: Cloud Console OAuth consent screen + Web client (redirect
     `https://tinyglow.app/auth/callback`), later iOS and Android clients (step 9) →
     `GOOGLE_CLIENT_ID=<web>,<ios>,<android>`, `GOOGLE_CLIENT_SECRET=<web secret>`,
     `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`.
  3. Cloudflare Turnstile widget for `tinyglow.app` → `TURNSTILE_SITE_KEY`,
     `TURNSTILE_SECRET_KEY`.
  4. Transactional email (Postmark or Resend SMTP, verified sender, SPF/DKIM/DMARC) →
     `SMTP_HOST/PORT/USER/PASS`, `SMTP_ADMIN_EMAIL`, `MAIL_FROM` (now used by GoTrue and the API).
  5. Legal: Terms and Privacy Policy text (placeholders ship with version `2026-10-08`).
