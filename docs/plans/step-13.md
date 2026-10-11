# Step 13 plan: Passkey sign-in

Status: proposed (architect, 2026-10-11). Not a PRD build-order step: the PRD's "Sign-in methods"
table lists **Passkeys** as P2 on every platform; the user asked for them now ("passkey auth").
Starts after step 12 is committed (independent of it in code; sequenced for review load). No app
migration is planned (GoTrue owns the credential tables); if 2.2 finds one is needed it is
`1792600000100_passkeys.sql`.

PRD sections touched: "Accounts and authentication" (passwordless only; "One email = one
account"), "Sign-in methods" (Passkeys P2; email OTP stays primary), "Sessions and tokens",
"Account deletion and recovery" ("email-code sign-in to the same address recovers the account"),
"Auth security requirements" (rate limits, generic responses, audit events), FR-1.1 as narrowed by
`CLAUDE.md` ("Email 6-digit OTP is primary; magic link is web-only fallback. Passwordless only."),
"Mobile and Capacitor → App store requirements", "Decisions to confirm" (web container serves
`/.well-known/*`). `CLAUDE.md`: self-hosted GoTrue is the only identity provider; the API is
GoTrue's only client (browsers reach `/auth/{health,authorize,callback}` only); never log tokens;
dev stack zero-setup.

**Research result (2026-10-11).** `supabase/auth` **v2.197.0 — the tag already pinned in both
compose files — ships first-factor passkeys** (beta, announced 2026-05-28): routes
`POST /passkeys/authentication/options` (public, discoverable credentials, GoTrue rate limiter
`GOTRUE_RATE_LIMIT_PASSKEY`), `POST /passkeys/authentication/verify` (returns the normal
`AccessTokenResponse`, i.e. a full session), `POST /passkeys/registration/{options,verify}`
(authenticated, non-anonymous, non-SSO; `too_many_passkeys` at `GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER`,
default 10), `GET /passkeys`, `PATCH /passkeys/{id}` (`friendly_name` ≤ 120), `DELETE
/passkeys/{id}`, admin list/delete under `/admin/users/{id}/passkeys`. Config:
`GOTRUE_PASSKEY_ENABLED` (default false), `GOTRUE_WEBAUTHN_RP_ID` (bare domain),
`GOTRUE_WEBAUTHN_RP_DISPLAY_NAME`, `GOTRUE_WEBAUTHN_RP_ORIGINS` (comma list, ≤ 5, https or
loopback, or `android:apk-key-hash:<base64url sha256 of the signing cert>`),
`GOTRUE_WEBAUTHN_CHALLENGE_EXPIRY_DURATION` (5m). Challenges are single-use rows keyed by
`challenge_id`; the verify response requires a confirmed email and refuses banned users; sign-in
is recorded as a `PasskeyLogin` audit action. **Decision: GoTrue-native.** An API-side WebAuthn
implementation (`@simplewebauthn/server` minting GoTrue sessions through `admin/generate_link`)
would duplicate a credential store, bypass GoTrue's audit/rate limits and make the API a token
issuer; it stays the fallback only if the beta API breaks (5.2).

## 0. Decisions (user, 2026-10-11; all questions closed — the ids Q1–Q7 are referenced below)

| # | Decision | Value |
| --- | --- | --- |
| Q1 | Rollout | **Web first**: web + API + Settings now; iOS/Android native ceremonies are coded now and verified in Part B (Team ID, signing cert) |
| Q2 | Enrol prompt | **Once, after the first OTP sign-in** (dismissible card after the sign-up flow finishes, not inside steps 1–8); **30-day snooze**, re-offered at most once; always available in Settings |
| Q3 | Max passkeys per account | **5** (`GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER=5`; GoTrue default is 10) |
| Q4 | Fresh sign-in (≤ 10 min) | **Required for removing a passkey; not for adding one** |
| Q5 | Passkey sign-in as "fresh sign-in" | **Yes** (user-verified, creates a new GoTrue session like OTP) |
| Q6 | Store-review account | **Cannot register passkeys** |
| Q7 | Email on add/remove | **Yes**, new-device-alert template family, no links |

### 0.1 GoTrue facts to re-verify at build time (security-engineer, task 13.4)

What this plan relies on and where it was read (2026-10-11), so the build can diff against the
pinned image `supabase/auth:v2.197.0` and stop if anything moved:

| Fact | Source | Confidence |
| --- | --- | --- |
| Passkey code exists at the tag: `internal/api/passkey_{authentication,registration,manage,admin,webauthn}.go` | GitHub tree at `v2.197.0` | confirmed at the tag |
| Config: `GOTRUE_PASSKEY_ENABLED` (false), `GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER` (10), `GOTRUE_WEBAUTHN_RP_ID`, `GOTRUE_WEBAUTHN_RP_DISPLAY_NAME`, `GOTRUE_WEBAUTHN_RP_ORIGINS` (all three required when enabled; validation failures are **logged as warnings, not fatal**), `GOTRUE_WEBAUTHN_CHALLENGE_EXPIRY_DURATION` (5m), `GOTRUE_RATE_LIMIT_PASSKEY` (30) | `internal/conf/configuration.go` at `v2.197.0` | confirmed at the tag; `RP_ID`/`RP_DISPLAY_NAME`/`RP_ORIGINS` spelling confirmed by validation messages, the rest inferred from envconfig tags. **Not in the tag's `example.env`** (undocumented there; only the MFA `GOTRUE_MFA_WEB_AUTHN_*` flags are) |
| Routes: `POST /passkeys/authentication/options` (rate-limited + GoTrue captcha), `POST /passkeys/authentication/verify`, `POST /passkeys/registration/{options,verify}` (auth, non-anonymous), `GET /passkeys`, `PATCH|DELETE /passkeys/{passkey_id}`, `GET|DELETE /admin/users/{user_id}/passkeys[/{passkey_id}]`; group middleware `requirePasskeyEnabled` | `internal/api/api.go` read on **`master`**, handler files at the tag | **re-read `api.go` at `v2.197.0`** before coding the client; paths may have differed before GA |
| Shapes: options responses `{ challenge_id, options, expires_at }` (`options` is the raw W3C JSON, not wrapped in `publicKey`); verify requests `{ challenge_id, credential }`; authentication verify returns the standard `AccessTokenResponse`; registration verify returns `{ id, friendly_name?, created_at }`; passkey object adds `last_used_at`; `PATCH { friendly_name ≤ 120 }`; `DELETE` → 204 | handler files at the tag | confirmed at the tag |
| Error codes seen in handlers: `too_many_passkeys`, `webauthn_challenge_not_found`, `webauthn_challenge_expired`, `webauthn_verification_failed`, `webauthn_credential_exists`, `validation_failed`, `bad_json`, `email_not_confirmed`, `user_banned`; `passkey_disabled` is documented by Supabase for the disabled middleware but was **not seen in the handler files** | handler files + Supabase docs | partly confirmed; map any unknown code to `passkey_failed` |
| `requirePasskeyManagementAAL(user, session)` guards registration and delete | handler files | semantics **unverified** (assumed AAL1 passes with no MFA factors; test it) |
| Discoverable login only (`BeginDiscoverableLogin`, user from `userHandle`); email must be confirmed; friendly name derived from AAGUID | handler files | confirmed at the tag |
| Credential/challenge tables live in the `auth` schema and cascade on user delete | Supabase docs ("deleting a user's last passkey…"); schema not read | **unverified** — hand check in 13.2 |
| Whole feature is **beta** ("experimental; may change without notice"), opt-in client flag on the hosted SDKs | Supabase changelog 2026-05-28, docs | documented; pin the tag, re-run the gate on any GoTrue upgrade |

## 1. Goal

Add passkeys as a faster way to sign in to an existing account, on top of the email code that
stays primary and remains the recovery path. The API fronts GoTrue's beta passkey endpoints the
same way it fronts OTP (throttles, Turnstile after abuse, generic errors, audit, cookies for web
and tokens for native); nothing in Postgres `public` changes and no credential material is ever
stored or logged by the API. Web uses the browser's WebAuthn API with the autofill ("conditional
UI") affordance on the email field and an explicit "Sign in with a passkey" button; iOS and
Android use the platform passkey APIs through a small in-house Capacitor plugin so the relying
party is `tinyglow.app` (the WebView origin `capacitor://localhost` can never be a WebAuthn
origin). Users enrol after an OTP sign-in, manage passkeys in Settings, and can always fall back to
the email code; deleting the account deletes the credentials with the GoTrue user.

## 2. Interfaces first

### 2.1 Topology

```
sign-in  web: email field (autocomplete="username webauthn", conditional mediation) or "Sign in with a passkey"
         native: "Sign in with a passkey" → TinyglowPasskeys.get(options)
   ─▶ POST /api/auth/passkey/options            api: IP throttle → GoTrue POST /passkeys/authentication/options
   ◀─ { challengeId, options (PublicKeyCredentialRequestOptions JSON), expiresAt }
   ─▶ navigator.credentials.get / ASAuthorization / CredentialManager
   ─▶ POST /api/auth/passkey/verify { challengeId, credential }   api → GoTrue …/authentication/verify
      → AccessTokenResponse → issueSession(kind:'sign_in', method:'passkey')  (cookies | tokens)
enrol    signed in ─▶ POST /api/me/passkeys/options → GoTrue …/registration/options (user's access token)
         ─▶ navigator.credentials.create / platform API ─▶ POST /api/me/passkeys { challengeId, credential, name? }
         → GoTrue …/registration/verify (+ PATCH friendly_name) → audit auth.passkey_added → email (Q7)
manage   GET /api/me/passkeys · PATCH /api/me/passkeys/:id { name } · DELETE /api/me/passkeys/:id (fresh sign-in, Q4)
GoTrue   GOTRUE_PASSKEY_ENABLED=true  RP_ID=tinyglow.app  RP_ORIGINS=https://tinyglow.app,android:apk-key-hash:…
         dev: RP_ID=localhost  RP_ORIGINS=http://localhost:8080
nginx    unchanged: /auth/passkeys/* stays 404 for browsers; everything goes through /api
```

No new service. New client dependency: **none on web** (WebAuthn is a browser API; the API
returns GoTrue's JSON unchanged apart from camelCase wrappers). Native: in-house
`TinyglowPasskeys` plugin (D2). Server: no new dependency (plain `fetch` to GoTrue, zod).

### 2.2 Database (security-engineer): none planned

GoTrue creates and owns its passkey tables under `auth` (its own migrations ran when v2.197.0
first booted; 12.2-style hand check: `\dt auth.*` lists the passkey/challenge tables). Verify in
2.2a (task 13.2): (a) the tables cascade on `auth.users` delete (account deletion already hard
deletes the GoTrue user); (b) `supabase_auth_admin` needs no new grant; (c) nothing in `public`
references them. If (a) fails, GoTrue's admin passkey delete is called before the user delete
(`account.ts`), no app migration. The only possible app migration is an `audit_log` metadata
shape change if `auditMetadataSchema` gains `passkey_id` — it is JSONB, no DDL.

### 2.3 Shared contracts (`@tinyglow/shared`; architect-defined here, backend-engineer writes in 13.1 with orchestrator approval)

- `api/auth.ts`:
  - `passkeyOptionsResponseSchema = z.object({ challengeId: z.uuid(), options:
    z.record(z.string(), z.unknown()) /* PublicKeyCredentialRequestOptionsJSON, passed through */,
    expiresAt: isoDateTimeSchema })`.
  - `passkeyVerifyRequestSchema = z.object({ challengeId: z.uuid(), credential:
    publicKeyCredentialJsonSchema })` where `publicKeyCredentialJsonSchema = z.object({ id:
    base64url 1..1024, rawId: base64url, type: z.literal("public-key"), response: z.object({
    clientDataJSON: base64url ≤ 8 KiB, authenticatorData?: base64url ≤ 8 KiB, signature?:
    base64url, userHandle?: base64url.nullable(), attestationObject?: base64url ≤ 64 KiB,
    transports?: z.array(z.enum(["usb","nfc","ble","internal","hybrid","smart-card"])) }),
    authenticatorAttachment?: z.enum(["platform","cross-platform"]).nullable(), clientExtensionResults:
    z.record(z.string(), z.unknown()).default({}) })` (strict sizes so the API never forwards
    arbitrary blobs).
  - `passkeyRegistrationOptionsResponseSchema` (same shape, `options` =
    `PublicKeyCredentialCreationOptionsJSON`), `passkeyRegisterRequestSchema = { challengeId,
    credential, name?: z.string().trim().min(1).max(60) }`.
  - `passkeySchema = z.object({ id: z.uuid(), name: z.string(), createdAt, lastUsedAt:
    isoDateTimeSchema.nullable() })`; `passkeysListResponseSchema = { passkeys: array.max(10),
    max: int }`; `passkeyRenameRequestSchema = { name }`.
  - `authConfigResponseSchema` += `passkeys: z.boolean()` (feature flag for the UI).
  - `sessionResponseSchema` unchanged.
- `api/errors.ts` codes: `passkey_disabled` (404), `passkey_failed` (401, generic: unknown
  credential, bad signature, expired/used challenge), `passkey_limit` (409, `details: { max }`),
  `passkey_exists` (409), `passkey_not_found` (404), `passkey_unavailable_for_account` (403, the
  review account).
- `auth.ts`: `AUDIT_EVENTS` += `auth.passkey_added`, `auth.passkey_removed`,
  `auth.passkey_renamed`; `auditMetadataSchema.method` enum += `"passkey"`; `+= passkey_id:
  z.uuid().optional()` (never a name typed by the user, never credential ids);
  `PASSKEY_OPTIONS_PER_IP_PER_HOUR = 60`, `PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN = 10`,
  `PASSKEY_MAX_PER_USER = 5` (Q3; mirror of the GoTrue env), `PASSKEY_NAME_MAX = 60`,
  `PASSKEY_PROMPT_SNOOZE_DAYS = 30`.
- `env.ts` `passkeyEnvSchema` (api): `AUTH_PASSKEYS_ENABLED` boolean default false (must equal
  `GOTRUE_PASSKEY_ENABLED`; both fed by one `.env` flag like the social providers).
- `native.ts`: `PASSKEY_PROMPT_KEY = "ll.passkey.prompt.v1"` (secure store / localStorage marker:
  `{ snoozedUntil }` only — allow-list it in the storage hygiene check).
- `telemetry.ts`: scrub `clientDataJSON`, `attestationObject`, `authenticatorData`, `signature`,
  `challenge_id`/`challengeId` values.

### 2.4 Auth API (`apps/api/src/auth/**`; security-engineer)

- `gotrue.ts` `GoTrueClient` += `passkeyAuthOptions(upstream)`, `passkeyAuthVerify({ challengeId,
  credential }, upstream): Promise<GoTrueSession>`, `passkeyRegOptions(accessToken, upstream)`,
  `passkeyRegVerify(accessToken, { challengeId, credential }, upstream): Promise<GoTruePasskey>`,
  `passkeyList(accessToken)`, `passkeyRename(accessToken, id, name)`, `passkeyDelete(accessToken,
  id)`. GoTrue error codes mapped: `passkey_disabled` → 404; `webauthn_verification_failed`,
  `webauthn_challenge_not_found`, `webauthn_challenge_expired`, `validation_failed` (on verify) →
  401 `passkey_failed` (one generic code, so a probe cannot tell "unknown credential" from "wrong
  signature"); `too_many_passkeys` → 409 `passkey_limit`; `webauthn_credential_exists` → 409
  `passkey_exists`; `email_not_confirmed`/`user_banned` → 401 `passkey_failed`. Bodies are never
  logged (existing rule: status + `error_code` only).
- `routes.ts`:
  - `POST /auth/passkey/options` (public): 404 `passkey_disabled` unless `AUTH_PASSKEYS_ENABLED`;
    throttle `PASSKEY_OPTIONS_PER_IP_PER_HOUR` on the client IP (same in-memory limiter as OTP);
    Turnstile required after 3 failed verifies from the IP in 15 min (reuse `captcha_required`);
    forwards `upstreamClientHeaders` so GoTrue's own `GOTRUE_RATE_LIMIT_PASSKEY` sees the browser;
    returns `passkeyOptionsResponseSchema`. Log `{ outcome }` only.
  - `POST /auth/passkey/verify` (public): validate body; GoTrue verify → `issueSession(request,
    reply, session, { kind: "sign_in", method: "passkey" })` (profile upsert, suspended check,
    `auth.sign_in` + `auth.new_device`, cookies or tokens — unchanged code path). Failure counter
    per IP → `PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN` ⇒ 429 `rate_limited`. The review
    account's `issueSession` path is untouched (it never has passkeys, Q6).
  - `GET /auth/config` += `passkeys`.
- `passkeys.ts` (new; `requireAuth` + `requireConsent`; the caller's access token is the cookie
  `ll_access` or the bearer, already available to the handler):
  - `POST /me/passkeys/options` → 403 `passkey_unavailable_for_account` for the review account
    (`REVIEW_ACCOUNT_EMAIL`), else GoTrue registration options (GoTrue enforces the per-user max;
    the API also pre-checks `list().length >= PASSKEY_MAX_PER_USER` for a clean 409).
  - `POST /me/passkeys` → GoTrue registration verify → optional rename → audit
    `auth.passkey_added { passkey_id }` under claims → Q7 email "A passkey was added to your
    Tinyglow account on {device label}" (no link) → 201 `passkeySchema`.
  - `GET /me/passkeys` → `{ passkeys, max }`.
  - `PATCH /me/passkeys/:id` → rename (trimmed, `emailShape`-style control-character check) →
    audit `auth.passkey_renamed`.
  - `DELETE /me/passkeys/:id` → `requireFreshSignIn` (Q4) → GoTrue delete → audit
    `auth.passkey_removed { passkey_id }` → Q7 email → 204. Removing the last passkey is allowed
    (OTP remains).
- `account.ts` (deletion): nothing new if 2.2 (a) holds; else delete passkeys via the admin route
  before `adminDeleteUser`. Deletion preview lists `passkeys: n`.
- `sessions.ts`: the devices list shows `signInMethod` (`otp` | `passkey` | `apple` | `google` |
  `review`) read from the session's `auth.sign_in` audit row (already written per session) — a
  SECURITY DEFINER read already exists for sessions (`auth_session_info`); extend its SELECT list
  with nothing (method comes from `audit_log`, which the user can read for their own actor rows).
- pino `redact` += `*.credential`, `*.challengeId`, `*.challenge_id`, `*.clientDataJSON`,
  `*.attestationObject`, `*.authenticatorData`, `*.signature`.

### 2.5 Web app (`apps/mobile-web/src/**`; frontend-engineer)

- `lib/passkeys.ts`: `supported()` (`window.PublicKeyCredential` +
  `isUserVerifyingPlatformAuthenticatorAvailable()`), `conditionalUiSupported()`
  (`isConditionalMediationAvailable()`), `signIn({ conditional })`: options → `navigator.credentials.get({
  publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options), mediation })` → `credential.toJSON()`
  → verify → session store (same handler as OTP verify). `register(name?)`: options →
  `navigator.credentials.create({ publicKey: parseCreationOptionsFromJSON(options) })` → register.
  Polyfill-free: `parse*FromJSON`/`toJSON` exist in current Safari/Chrome/Firefox; when absent,
  hide the feature (no library).
- Welcome / sign-in page: email input gets `autocomplete="username webauthn"` and starts a
  conditional-mediation `get` on mount when supported (silent; cancelled when the user submits
  the email); below the OTP button a secondary "Sign in with a passkey" button when `config.passkeys
  && supported()`. Errors: `passkey_failed` → "That passkey didn't work. Use your email code
  instead." (OTP form stays primary and visible). Native: the button calls the plugin (2.6).
- Enrol card (Q2): after sign-up completes (first album created or invite accepted) and after any
  later OTP sign-in, when `config.passkeys && supported() && passkeys.length === 0 && !snoozed`:
  "Sign in faster next time — add a passkey" with "Add passkey" / "Not now" (snooze 30 days,
  `PASSKEY_PROMPT_KEY`). Success toast + the Settings deep link.
- Settings → **Passkeys**: list (name, created, last used), rename inline, "Add a passkey",
  remove with confirm; removal hits the fresh-sign-in gate like other destructive actions (the
  existing gate component re-signs in with OTP or a passkey). Devices list shows the sign-in
  method label.
- Copy in `i18n/en.ts`; `scripts/screenshots-passkeys.ts` (welcome with the button, enrol card,
  Settings list, remove confirm) light/dark × phone/desktop per `docs/DESIGN.md`.

### 2.6 Native (`apps/mobile-web/ios/**`, `apps/mobile-web/android/**`, `capacitor.config.ts`, `NATIVE.md`, `store/**`; mobile-engineer)

- In-house plugin **`TinyglowPasskeys`** (D2), JS name `TinyglowPasskeys`, methods `available()
  → { available }`, `create({ options }) → { credential }`, `get({ options, preferImmediatelyAvailable? })
  → { credential }`; input/output are the W3C JSON forms, so `lib/passkeys.ts` branches only on
  platform. Errors: `cancelled`, `not_available`, `failed` (no messages from the OS are
  forwarded).
  - iOS (`TinyglowPasskeys.swift`, iOS 16+): `ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier:
    "tinyglow.app")`, `createCredentialRegistrationRequest(challenge:name:userID:)` /
    `createCredentialAssertionRequest(challenge:)` with `allowedCredentials` from the options;
    `ASAuthorizationController` with `preferImmediatelyAvailableCredentials` for the explicit
    button; results mapped to JSON (`rawClientDataJSON`, `rawAttestationObject`,
    `rawAuthenticatorData`, `signature`, `userID`, base64url). Entitlement `App.entitlements` +=
    `webcredentials:tinyglow.app` (Associated Domains; the Debug build adds
    `webcredentials:tinyglow.app?mode=developer`). The RP id is a build-time constant equal to the
    production host; dev-stack testing on a device is not possible (RP id must match a served
    AASA) — the iOS gate stubs the plugin.
  - Android (`TinyglowPasskeysPlugin.java`, `androidx.credentials:credentials` +
    `credentials-play-services-auth`, minSdk unchanged; passkeys need Android 9+ with Google Play
    services): `CreatePublicKeyCredentialRequest(requestJson)` / `GetCredentialRequest(GetPublicKeyCredentialOption(requestJson))`
    through `CredentialManager`; the response JSON is returned verbatim. The app's origin at GoTrue
    is `android:apk-key-hash:<base64url(sha256(signing cert))>` (one per signing key: debug,
    upload, Play App Signing ⇒ ≤ 3 of the 5 origins).
- Association files (`apps/mobile-web/public/.well-known/*`, copied into both native `public`
  folders by `cap sync`): AASA gains `"webcredentials": { "apps": ["<APPLE_TEAM_ID>.app.tinyglow"] }`
  (placeholder team id until Part B, like `applinks`); `assetlinks.json` gains a second statement
  `delegate_permission/common.get_login_creds` for `app.tinyglow` with the same SHA-256
  fingerprints (placeholders). nginx already serves `/.well-known/*` with `application/json`.
- `NATIVE.md`: passkey setup, the apk-key-hash computation
  (`keytool -exportcert … | openssl sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='`),
  developer-mode AASA. Store copy: "Sign in with a passkey" in the feature list; privacy label:
  no new data type (a public key is an account credential; Data Safety: no new category).

### 2.7 Devops (`docker-compose*.yml`, `.env.example`, `.env.dev`, `.github/**`, `docs/PRODUCTION.md`)

- `auth` service (both files): `GOTRUE_PASSKEY_ENABLED: ${AUTH_PASSKEYS_ENABLED:-false}`,
  `GOTRUE_WEBAUTHN_RP_ID: ${WEBAUTHN_RP_ID:-tinyglow.app}`, `GOTRUE_WEBAUTHN_RP_DISPLAY_NAME:
  Tinyglow`, `GOTRUE_WEBAUTHN_RP_ORIGINS: ${WEBAUTHN_RP_ORIGINS:-https://tinyglow.app}`,
  `GOTRUE_WEBAUTHN_CHALLENGE_EXPIRY_DURATION: 5m`, `GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER:
  ${PASSKEY_MAX_PER_USER:-5}`, `GOTRUE_RATE_LIMIT_PASSKEY: "30"` (dev 1000, like the OTP limits
  so the API's limits are what tests exercise). `api` gets `AUTH_PASSKEYS_ENABLED`. Dev defaults:
  enabled, `localhost`, `http://localhost:8080`.
- `.env.example` section "Passkeys (docs/plans/step-13.md; auth + api)": the flag, RP id, origins
  (how to add the Android origins), a warning that **changing the RP id invalidates every
  passkey**.
- CI: `passkey-hygiene.sh` (no `clientDataJSON|attestationObject|challenge` values in the log
  tap; `apps/api/src/auth/passkeys.ts` has no `log.` with a body field; the nginx allow-list still
  404s `/auth/passkeys/…`); e2e runs with the Playwright virtual authenticator (2.8).
- `docs/PRODUCTION.md`: Part C adds the three variables; Part H (phone apps) adds the
  `webcredentials` AASA key, the `get_login_creds` assetlinks statement and the apk-key-hash
  origins; Part I note "turn passkeys on only after the domain is final".

### 2.8 Tests and gate (test-engineer)

- api: options/verify happy path against a recording GoTrue stub (`testing/support.ts` gains the
  seven methods), each GoTrue error → one generic `passkey_failed`, IP throttle + Turnstile after
  3 failures, review account 403 on options, fresh-sign-in gate on delete, audit rows with
  `passkey_id` and never a name/credential, Q7 emails sent (Mailpit in integration), deletion
  preview count, `auth/config.passkeys`.
- api integration against **real GoTrue** (dev stack, RP `localhost`): a WebAuthn ceremony needs
  an authenticator — use `@simplewebauthn/server`'s test helpers? No new server dependency:
  the integration test drives **Playwright's CDP virtual authenticator** (`WebAuthn.enable`,
  `addVirtualAuthenticator { protocol: "ctap2", transport: "internal", hasResidentKey: true,
  hasUserVerification: true, isUserVerified: true }`) in `e2e/auth/passkeys.spec.ts`: OTP sign-in
  → enrol → sign out → sign in with the passkey → Settings shows last used → rename → remove
  (fresh gate) → OTP still works; `passkey_limit` after 5; account deletion removes the GoTrue
  passkey rows (psql `select count(*) from auth.<passkey table> where user_id = …` = 0).
- web unit: `lib/passkeys.ts` branches (unsupported browser hides UI; conditional UI cancel on
  submit), enrol card snooze, Settings list states.
- db hand check (13.2): tables, cascade, grants.
- native: iOS gate adds "passkey button hidden when plugin `available=false`" (simulator has no
  passkeys for an unassociated RP); Android lint; **real-device ceremonies are Part B**.
- gate `pnpm e2e:passkey-gate` (`e2e/auth/passkey-gate.ts`): the spec above plus the log tap
  (no credential fields, challenge ids, or `Bearer`), 429 after 60 options calls from one IP,
  `GET /auth/passkeys/authentication/options` through nginx → 404.

## 3. Tasks

### Group 0 (parallel)

**13.1 Shared contracts** — backend-engineer (orchestrator approval). Owns
`packages/shared/src/{auth,env,native,telemetry,index}.ts`, `packages/shared/src/api/{auth,errors}.ts`.
Inputs: 2.3. Done when: schemas/codes/constants exist as specified; `publicKeyCredentialJsonSchema`
rejects an 8 KiB+ `clientDataJSON`; shared tests green.

**13.2 GoTrue tables hand check + deletion path** — security-engineer. Owns
`packages/db/README.md` (a section "GoTrue passkey tables"), `apps/api/src/auth/account.ts` (only
if cascade fails). Done when: the README lists the GoTrue passkey/challenge tables, their FK
behaviour on `auth.users` delete (proven by a psql test on the dev stack), and states that no
app role can read them.

**13.3 Compose, env, guide** — devops-engineer. Owns `docker-compose.yml`,
`docker-compose.dev.yml`, `.env.example`, `.env.dev`, `docs/PRODUCTION.md`. Inputs: 2.7. Done
when: dev `auth` answers `POST http://localhost:9999/passkeys/authentication/options` (from inside
the compose network) with a `challenge_id`; through nginx the same path is 404; both `config`
clean; guide updated.

### Group 1 (parallel; after group 0)

**13.4 Auth API** — security-engineer. Owns `apps/api/src/auth/**` (`passkeys.ts` new,
`gotrue.ts`, `routes.ts`, `sessions.ts`, `account.ts`), `apps/api/src/app.ts` redact list (the
one-line change is coordinated with backend-engineer; or backend adds it in 13.1b if preferred).
Inputs: 2.4, 2.3, **0.1 (verify every row against `supabase/auth:v2.197.0` first: `api.go` route
paths at the tag, config env names, error codes; record the result in the task summary and stop
if a path or shape differs)**. Done when: every route in 2.4 behaves as specified against the dev GoTrue;
`rg -n "log\." apps/api/src/auth/passkeys.ts` shows only `{ outcome }` lines; the review account
gets 403 on options.

**13.5 Web app** — frontend-engineer. Owns `apps/mobile-web/src/**`,
`apps/mobile-web/scripts/screenshots*.ts`. Inputs: 2.5, 2.3. Done when: Chrome with the virtual
authenticator completes enrol and sign-in; unsupported browsers show no passkey UI; Settings list,
rename, remove (fresh gate) work; screenshots reviewed.

**13.6 Native plugin, entitlements, association files, store copy** — mobile-engineer. Owns
`apps/mobile-web/ios/**`, `apps/mobile-web/android/**`, `apps/mobile-web/public/.well-known/**`,
`capacitor.config.ts`, `apps/mobile-web/NATIVE.md`, `apps/mobile-web/store/**`. Inputs: 2.6. Done
when: iOS simulator build succeeds with the entitlement and the plugin reports
`available=false` without an associated RP (no crash); Android debug build + lint pass with the
Credential Manager dependency; AASA has `webcredentials`, assetlinks has `get_login_creds`
(placeholders); `check-ios-plists.ts` passes.

### Group 2 (after group 1)

**13.7 Tests and gate** — test-engineer. Owns `**/*.test.ts(x)`, `e2e/**`,
`apps/api/src/testing/*`, root `package.json` script `e2e:passkey-gate` (orchestrator approves).
Inputs: 2.8. Done when: all suites in 2.8 green; `pnpm e2e` includes `passkeys.spec.ts`; gate
prints `PASS n/n`.

### Group 3 (after 13.7)

**13.8 CI** — devops-engineer. Owns `.github/**`. Done when: hygiene script in the lint job, the
passkey gate + log tap in the dev-stack job, actionlint clean.

### Group 4 — gate, PROGRESS, commit (orchestrator); Part B list in 5.3

| Group | Tasks |
| --- | --- |
| 0 | 13.1 (backend) ‖ 13.2 (security) ‖ 13.3 (devops) |
| 1 | 13.4 (security) ‖ 13.5 (frontend) ‖ 13.6 (mobile) |
| 2 | 13.7 (test-engineer) |
| 3 | 13.8 (devops) |
| 4 | orchestrator |

## 4. Acceptance checks

```sh
pnpm lint && pnpm typecheck && pnpm typecheck:e2e
bash .github/scripts/passkey-hygiene.sh && bash .github/scripts/native-hygiene.sh
pnpm test && pnpm test:integration
# GoTrue reachable only through the api:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/auth/passkeys/authentication/options   # 404
docker compose -f docker-compose.dev.yml exec -T api node -e "fetch('http://auth:9999/passkeys/authentication/options',{method:'POST'}).then(r=>r.json()).then(j=>console.log(Object.keys(j)))"  # challenge_id options expires_at
# API:
curl -s -H 'x-tinyglow-client: web' -X POST http://localhost:8080/api/auth/passkey/options | jq 'keys'       # challengeId expiresAt options
curl -s http://localhost:8080/api/auth/config | jq .passkeys                                                  # true (dev)
CI=1 pnpm e2e --grep passkeys && pnpm e2e:passkey-gate
# log tap: no credential material
docker compose -f docker-compose.dev.yml logs api auth --since 30m | grep -Eic 'clientDataJSON|attestationObject|challenge_id|Bearer '   # 0
```

Gate procedure: 4 green → fresh dev stack → smoke → `restart-api.sh` → `pnpm e2e` → passkey gate →
iOS simulator build + gate → screenshots → PROGRESS (Q1–Q7 as recorded in section 0, D1–D6,
the 0.1 verification results, Part B list) → `git commit -m "step 13: passkey sign-in"`.

## 5. Risks and decisions

### 5.1 Architecture decisions (architect defaults; orchestrator confirms or overrides — the user's Q1–Q7 are in section 0)

- **D1 GoTrue-native passkeys** (first factor, discoverable credentials). The API proxies and
  wraps, never verifies WebAuthn itself and never stores credentials. Fallback if the beta API
  changes incompatibly: pin GoTrue, or implement `@simplewebauthn/server` in the API with its own
  `public.passkeys` table (FORCE RLS, self-only) minting sessions via
  `adminGenerateMagicLink` + `verify(token_hash)` (the review-account mechanism) — flagged, not
  built.
- **D2 In-house Capacitor plugin** for native ceremonies (consistent with the uploader/photo-sync
  decisions: tiny surface, no privacy-manifest or logging surprises). Community alternatives
  (`@darkedges/capacitor-native-webauthn`, `capacitor-native-passkey`) exist; evaluate only if the
  in-house one exceeds ~300 lines per platform.
- **D3 One generic failure code** (`passkey_failed`) for every verify-time problem, mirroring the
  OTP "generic responses" rule.
- **D4 OTP stays primary**; passkeys never become the only way in; removing the last passkey is
  allowed; lost-device recovery is the email code (PRD "Lost access").
- **D5 Max 5 passkeys**; Q3.
- **D6 Passkey sign-in = fresh sign-in**; Q5. GoTrue's `requirePasskeyManagementAAL` exists on
  registration/delete — with no MFA factors enrolled it is AAL1 and passes; if it ever demands
  AAL2 the API surfaces 403 `passkey_failed` and the fallback is OTP re-sign-in (test asserts the
  current behaviour).

### 5.2 Risks

- **Beta API**: Supabase marks passkeys "experimental; may change without notice". Pinning
  v2.197.0 freezes the contract; a GoTrue upgrade must re-run the passkey gate first (note in the
  guide's "Updating Tinyglow later").
- **RP id is forever**: `tinyglow.app` must be final before any user enrols (the rename happened
  on 2026-10-10; confirm the domain decision is closed).
- **WebView**: WebAuthn inside Capacitor's WebView does not work for RP `tinyglow.app` (origin
  mismatch), hence the native plugin; the web path is never offered on native.
- **Android origins**: each signing key is one origin and GoTrue allows 5; debug + upload + Play
  App Signing fit, but a key rotation needs an env change.
- **Conditional UI** needs `autocomplete="username webauthn"` on a text input and an in-flight
  `get` — the sign-in form must cancel it (AbortController) before starting the OTP flow, or
  Safari shows two prompts.
- **Testing**: real authenticators cannot be driven in CI; Playwright's CDP virtual authenticator
  covers Chromium only. Safari/Firefox are manual checks before launch.
- **Challenge TTL 5 min**: slow native users can expire it; the client restarts the ceremony on
  `passkey_failed` once.

### 5.3 Part B (needs the user; blocks only native verification)

| # | Needed | Unblocks | What we do with it |
| --- | --- | --- | --- |
| P1 | Apple Team ID (step-9 U1) | iOS passkeys | `webcredentials:tinyglow.app` entitlement signed; AASA `webcredentials.apps = ["<TEAM>.app.tinyglow"]` deployed |
| P2 | Android signing certificate SHA-256 (debug, upload, Play App Signing; step-9 U6) | Android passkeys | `assetlinks.json` `get_login_creds` fingerprints; `WEBAUTHN_RP_ORIGINS` += `android:apk-key-hash:…` per key; restart `auth` |
| P3 | Production deploy approval | both | serve the updated `/.well-known/*`, set `AUTH_PASSKEYS_ENABLED=true` on `auth` and `api` |
| P4 | A real iPhone (iOS 16+) and Android phone with Google Play services | device verification | run enrol → sign out → passkey sign-in → remove on each; record in PROGRESS |
| P5 | Decision whether passkeys appear in the store listing before P4 passes | store copy | keep the line out until verified |
