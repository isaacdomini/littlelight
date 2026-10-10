import { z } from "zod";
import { emailSchema, OTP_CODE_LENGTH } from "../auth";
import { isoDateTimeSchema } from "./common";

// `/api/auth/*` contracts (docs/plans/step-3.md 2.3, 2.4, 2.6). Tokens, codes and token hashes in
// these bodies are secrets: the API redacts them from logs and never echoes them back, except
// `tokens` for native clients (`x-tinyglow-client: native`).

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
    }),
  ),
});
export type SessionsListResponse = z.infer<typeof sessionsListResponseSchema>;
export type SessionListItem = SessionsListResponse["sessions"][number];

/** `GET /auth/config` (public). */
export const authConfigResponseSchema = z.object({
  providers: z.object({ apple: z.boolean(), google: z.boolean() }),
  turnstileSiteKey: z.string().nullable(),
  termsVersion: z.string(),
  privacyVersion: z.string(),
});
export type AuthConfigResponse = z.infer<typeof authConfigResponseSchema>;
