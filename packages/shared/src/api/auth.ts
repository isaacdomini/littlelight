import { z } from "zod";
import {
  emailSchema,
  OTP_CODE_LENGTH,
  PASSKEY_DEFAULT_NAME,
  PASSKEY_NAME_MAX,
  signInMethodSchema,
  WEBAUTHN_FIELD_MAX_CHARS,
} from "../auth";
import { isoDateTimeSchema } from "./common";

// `/api/auth/*` contracts (docs/plans/step-3.md 2.3, 2.4, 2.6; docs/plans/step-13.md 2.3, 2.4 for
// passkeys). Tokens, codes, token hashes and WebAuthn credential material in these bodies are
// secrets: the API redacts them from logs and never echoes them back, except `tokens` for native
// clients (`x-tinyglow-client: native`).

/** `POST /auth/otp`. Always answered 202 `{ ok: true }` (no account enumeration). */
export const otpRequestSchema = z.object({
  email: emailSchema,
  /** Cloudflare Turnstile token; required only after `captcha_required`. */
  captchaToken: z.string().min(1).max(2048).optional(),
});
export type OtpRequest = z.infer<typeof otpRequestSchema>;

/** `POST /auth/otp` 202 body. */
export const otpResponseSchema = z.object({ ok: z.literal(true) });
export type OtpResponse = z.infer<typeof otpResponseSchema>;

const otpCodeSchema = z.string().regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`));

/**
 * `POST /auth/verify`: either the emailed 6-digit code, or (web only) the magic-link
 * `token_hash` read from the `/signin/callback` URL fragment.
 */
export const verifyRequestSchema = z.union([
  z.object({ email: emailSchema, code: otpCodeSchema }),
  z.object({ tokenHash: z.string().min(1).max(512), type: z.literal("email") }),
]);
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

/** `POST /auth/pkce`: OAuth (Apple/Google) web return. `codeVerifier` per RFC 7636. */
export const pkceExchangeRequestSchema = z.object({
  code: z.string().min(1).max(512),
  codeVerifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
});
export type PkceExchangeRequest = z.infer<typeof pkceExchangeRequestSchema>;

export const oauthProviderSchema = z.enum(["apple", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/** `POST /auth/id-token`: native Apple/Google sign-in (step 9). */
export const idTokenRequestSchema = z.object({
  provider: oauthProviderSchema,
  idToken: z.string().min(1).max(8192),
  nonce: z.string().min(1).max(512).optional(),
  accessToken: z.string().min(1).max(8192).optional(),
});
export type IdTokenRequest = z.infer<typeof idTokenRequestSchema>;

/**
 * `POST /auth/refresh`. Web sends `{}` (the refresh token is the `ll_refresh` cookie); native
 * sends `{ refreshToken }`. A missing body parses as `{}`.
 */
export const refreshRequestSchema = z
  .object({ refreshToken: z.string().min(1).max(4096).optional() })
  .default({});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

/** `POST /auth/signout` → 204. `global` signs out every device. */
export const signOutRequestSchema = z.object({ scope: z.enum(["local", "global"]) });
export type SignOutRequest = z.infer<typeof signOutRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  /** Null only for GoTrue identities without an email (not reachable with our providers). */
  email: z.email().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** Response of every session-issuing endpoint (verify, pkce, id-token, refresh). */
export const sessionResponseSchema = z.object({
  user: sessionUserSchema,
  session: z.object({
    /** GoTrue session creation time (basis of "fresh sign-in"). */
    createdAt: isoDateTimeSchema,
    /** Access token expiry. */
    expiresAt: isoDateTimeSchema,
    isFresh: z.boolean(),
  }),
  /** Native clients only; web gets httpOnly cookies and never sees tokens. */
  tokens: z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      /** Seconds until the access token expires. */
      expiresIn: z.number().int().positive(),
    })
    .optional(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** `GET /auth/sessions`. No IPs; the User-Agent is reduced to `userAgentLabel`. */
export const sessionsListResponseSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.uuid(),
      createdAt: isoDateTimeSchema,
      lastActiveAt: isoDateTimeSchema,
      deviceLabel: z.string(),
      current: z.boolean(),
      /**
       * How this session was created (step 13, docs/plans/step-13.md 2.4): read from the session's
       * `auth.sign_in` audit row `method`; null/omitted when the row predates the field.
       */
      signInMethod: signInMethodSchema.nullable().optional(),
    }),
  ),
});
export type SessionsListResponse = z.infer<typeof sessionsListResponseSchema>;
export type SessionListItem = SessionsListResponse["sessions"][number];

/**
 * `details` of a 409 `inbox_has_family` (docs/plans/step-11.md 2.3, 2.4, 2.9): the address of the
 * other account for this inbox that is already a parent, masked with `maskEmail`
 * (`m***@gmail.com`). Never the full address. Omitted when the hint cannot be read.
 */
export const inboxHasFamilyDetailsSchema = z.object({
  existingEmailMasked: z.string().min(1).max(320),
});
export type InboxHasFamilyDetails = z.infer<typeof inboxHasFamilyDetailsSchema>;

/**
 * `details` of a 409 `pending_limit` (docs/plans/step-11.md 2.3, 2.5, 2.9): the caller's live
 * pending photos across this family and the most allowed (`public.pending_photo_limit()`,
 * default `PENDING_PHOTOS_PER_GUEST_PER_FAMILY`). Omitted when the trigger refused and the
 * route could not read the counts.
 */
export const pendingLimitDetailsSchema = z.object({
  pending: z.number().int().nonnegative(),
  limit: z.number().int().min(1),
});
export type PendingLimitDetails = z.infer<typeof pendingLimitDetailsSchema>;

/** `GET /auth/config` (public). `passkeys` (step 13) = `AUTH_PASSKEYS_ENABLED`: the UI's feature flag. */
export const authConfigResponseSchema = z.object({
  providers: z.object({ apple: z.boolean(), google: z.boolean() }),
  turnstileSiteKey: z.string().nullable(),
  termsVersion: z.string(),
  privacyVersion: z.string(),
  passkeys: z.boolean(),
});
export type AuthConfigResponse = z.infer<typeof authConfigResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Passkeys (docs/plans/step-13.md 0.1, 2.3, 2.4; PRD "Sign-in methods", "Auth security
// requirements"). The API fronts GoTrue's beta passkey routes: `options` responses are GoTrue's
// W3C JSON passed through under a camelCase wrapper; `credential` bodies are the browser's
// `PublicKeyCredential.toJSON()` (or the native plugins' identical JSON), size-capped so the API
// never forwards arbitrary blobs. Nothing here is logged: `clientDataJSON`, `attestationObject`,
// `authenticatorData`, `signature`, `userHandle`, `rawId` and challenge ids are redacted
// (`TELEMETRY_SCRUB_PATTERNS.webauthnPair`, pino `redact`).
// ---------------------------------------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/** A base64url string (unpadded as WebAuthn emits it; stray `=` padding tolerated), 1..`max` characters. */
export function base64urlSchema(max: number) {
  return z.string().min(1).max(max).regex(B64URL_RE, "must be base64url");
}

const F = WEBAUTHN_FIELD_MAX_CHARS;

/** `AuthenticatorTransport` values a credential may report (`response.transports`). */
export const WEBAUTHN_TRANSPORTS = [
  "usb",
  "nfc",
  "ble",
  "internal",
  "hybrid",
  "smart-card",
] as const;
export const webauthnTransportSchema = z.enum(WEBAUTHN_TRANSPORTS);
export type WebauthnTransport = z.infer<typeof webauthnTransportSchema>;

/**
 * `PublicKeyCredential.toJSON()` for both ceremonies: an assertion carries `authenticatorData` +
 * `signature` (+ `userHandle`), a registration `attestationObject` (+ `transports`). Every binary
 * field is base64url with a hard character cap (`WEBAUTHN_FIELD_MAX_CHARS`); unknown keys are
 * dropped. The API never decodes anything but the authenticator-data flags byte (UV check).
 */
export const publicKeyCredentialJsonSchema = z.object({
  id: base64urlSchema(F.id),
  rawId: base64urlSchema(F.id),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64urlSchema(F.clientDataJSON),
    authenticatorData: base64urlSchema(F.authenticatorData).optional(),
    signature: base64urlSchema(F.signature).optional(),
    userHandle: base64urlSchema(F.userHandle).nullable().optional(),
    attestationObject: base64urlSchema(F.attestationObject).optional(),
    transports: z.array(webauthnTransportSchema).max(WEBAUTHN_TRANSPORTS.length).optional(),
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).nullable().optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});
export type PublicKeyCredentialJson = z.infer<typeof publicKeyCredentialJsonSchema>;
/** The wire shape (before defaults): `clientExtensionResults` may be omitted. */
export type PublicKeyCredentialJsonInput = z.input<typeof publicKeyCredentialJsonSchema>;

/** Route params `/me/passkeys/:id`. */
export const passkeyParamsSchema = z.object({ id: z.uuid() });
export type PasskeyParams = z.infer<typeof passkeyParamsSchema>;

/**
 * `POST /auth/passkey/options` body. A missing body parses as `{}`. `captchaToken` (Cloudflare
 * Turnstile) is required only after the route answered 403 `captcha_required`: the IP had
 * `PASSKEY_CAPTCHA_AFTER_FAILURES` failed verifies in 15 minutes (same rule as `POST /auth/otp`).
 */
export const passkeyOptionsRequestSchema = z
  .object({ captchaToken: z.string().max(2048).optional() })
  .default({});
export type PasskeyOptionsRequest = z.infer<typeof passkeyOptionsRequestSchema>;

/**
 * `POST /auth/passkey/options` (public) → 200: GoTrue's `PublicKeyCredentialRequestOptionsJSON`
 * passed through as `options` (feed it to `PublicKeyCredential.parseRequestOptionsFromJSON`),
 * the single-use `challengeId` to send back with the assertion, and its expiry (GoTrue's Unix
 * seconds converted to ISO by the API, `passkeyOptionsFromGoTrue`). 404 `passkey_disabled`;
 * 429 `rate_limited` (`PASSKEY_OPTIONS_PER_IP_PER_HOUR`); 403 `captcha_required` after
 * `PASSKEY_CAPTCHA_AFTER_FAILURES` failed verifies from the IP (send `captchaToken`, like OTP).
 */
export const passkeyOptionsResponseSchema = z.object({
  challengeId: z.uuid(),
  options: z.record(z.string(), z.unknown()),
  expiresAt: isoDateTimeSchema,
});
export type PasskeyOptionsResponse = z.infer<typeof passkeyOptionsResponseSchema>;

/** `POST /me/passkeys/options` → 200: same wrapper, `options` = `PublicKeyCredentialCreationOptionsJSON`. */
export const passkeyRegistrationOptionsResponseSchema = passkeyOptionsResponseSchema;
export type PasskeyRegistrationOptionsResponse = z.infer<
  typeof passkeyRegistrationOptionsResponseSchema
>;

/**
 * `POST /auth/passkey/verify` (public) → 200 `sessionResponseSchema` (a full session, `isFresh`
 * true: a passkey sign-in is user-verified, Q5). 401 `passkey_failed` for every failure (unknown
 * credential, bad signature, expired or used challenge, missing user verification); 429
 * `rate_limited` on `PASSKEY_VERIFY_PER_IP_PER_HOUR` / `PASSKEY_VERIFY_FAILURES_PER_IP_PER_15_MIN`.
 */
export const passkeyVerifyRequestSchema = z.object({
  challengeId: z.uuid(),
  credential: publicKeyCredentialJsonSchema,
});
export type PasskeyVerifyRequest = z.infer<typeof passkeyVerifyRequestSchema>;

/** A passkey's display name as typed (trimmed, 1..`PASSKEY_NAME_MAX`; control characters rejected by the API). */
export const passkeyNameSchema = z.string().trim().min(1).max(PASSKEY_NAME_MAX);

/**
 * `POST /me/passkeys` → **201** `passkeySchema` (GoTrue answers 200 upstream). 403
 * `passkey_unavailable_for_account` (review account); 409 `passkey_limit { max }` /
 * `passkey_exists`; 401 `passkey_failed`.
 */
export const passkeyRegisterRequestSchema = z.object({
  challengeId: z.uuid(),
  credential: publicKeyCredentialJsonSchema,
  name: passkeyNameSchema.optional(),
});
export type PasskeyRegisterRequest = z.infer<typeof passkeyRegisterRequestSchema>;

/** One passkey as its owner sees it: never the credential id, public key, AAGUID or sign count. */
export const passkeySchema = z.object({
  id: z.uuid(),
  /** `friendly_name`, or `PASSKEY_DEFAULT_NAME` when GoTrue has none. */
  name: z.string().min(1).max(120),
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.nullable(),
});
export type Passkey = z.infer<typeof passkeySchema>;

/** `GET /me/passkeys`: the caller's passkeys (newest first) and the per-account maximum (`PASSKEY_MAX_PER_USER`). */
export const passkeysListResponseSchema = z.object({
  passkeys: z.array(passkeySchema).max(10),
  max: z.number().int().min(1),
});
export type PasskeysListResponse = z.infer<typeof passkeysListResponseSchema>;

/** `PATCH /me/passkeys/:id` → 200 `passkeySchema`; 404 `not_found`. */
export const passkeyRenameRequestSchema = z.object({ name: passkeyNameSchema });
export type PasskeyRenameRequest = z.infer<typeof passkeyRenameRequestSchema>;

// GoTrue wire shapes (v2.197.0, verified 2026-10-11, docs/plans/step-13.md 0.1): parsed by the
// API's `gotrue.ts` only. `expires_at` is Unix **seconds**; the list route returns a **bare
// array**; `friendly_name` / `last_used_at` are omitted when empty.

/** GoTrue `POST /passkeys/{authentication,registration}/options` body. */
export const goTruePasskeyOptionsSchema = z.object({
  challenge_id: z.uuid(),
  options: z.record(z.string(), z.unknown()),
  /** Unix seconds (int64). */
  expires_at: z.number().int().positive(),
});
export type GoTruePasskeyOptions = z.infer<typeof goTruePasskeyOptionsSchema>;

/** GoTrue's timestamps (`2026-10-11T12:34:56.123456Z`): RFC 3339 with any fraction precision. */
const goTrueTimeSchema = isoDateTimeSchema;

/** One GoTrue passkey (`GET /passkeys/` item, `registration/verify` and `PATCH` responses). */
export const goTruePasskeySchema = z.object({
  id: z.uuid(),
  friendly_name: z.string().max(120).nullish(),
  created_at: goTrueTimeSchema,
  last_used_at: goTrueTimeSchema.nullish(),
});
export type GoTruePasskey = z.infer<typeof goTruePasskeySchema>;

/** `GET /passkeys/` returns a bare JSON array (not an object). */
export const goTruePasskeyListSchema = z.array(goTruePasskeySchema).max(100);

/** `{ challenge_id, options, expires_at (Unix s) }` → the API's `passkeyOptionsResponseSchema`. */
export function passkeyOptionsFromGoTrue(g: GoTruePasskeyOptions): PasskeyOptionsResponse {
  return {
    challengeId: g.challenge_id,
    options: g.options,
    expiresAt: new Date(g.expires_at * 1000).toISOString(),
  };
}

/** A GoTrue passkey → `passkeySchema`: blank/absent `friendly_name` ⇒ `PASSKEY_DEFAULT_NAME`, absent `last_used_at` ⇒ null. */
export function passkeyFromGoTrue(g: GoTruePasskey): Passkey {
  const name = g.friendly_name?.trim();
  return {
    id: g.id,
    name: name ? name : PASSKEY_DEFAULT_NAME,
    createdAt: g.created_at,
    lastUsedAt: g.last_used_at ?? null,
  };
}
