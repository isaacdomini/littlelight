import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type {
  GoTrueClient,
  GoTruePasskeys,
  GoTrueReviewLinks,
  GoTrueSession,
} from "../auth/gotrue";
import type { ApiConfig } from "../config";

// Test-only helpers for the API unit and integration tests (docs/plans/step-3.md 3.10). Not
// imported by any production module. Dev literals only; nothing here is a real secret.

export const TEST_JWT_SECRET = "dev-only-jwt-secret-at-least-32-characters";
export const TEST_DATA_KEY = "dev-only-data-encryption-key-32-chars-min";
export const TEST_PUBLIC_URL = "http://localhost:8080";

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    API_HOST: "127.0.0.1",
    API_PORT: 3000,
    DATABASE_URL: "postgres://tinyglow_api:dev@db:5432/tinyglow",
    S3_ENDPOINT: "http://storage:9000",
    S3_PUBLIC_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "dev",
    S3_SECRET_KEY: "devdevdev",
    S3_BUCKET: "tinyglow-dev",
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: true,
    JWT_SECRET: TEST_JWT_SECRET,
    GOTRUE_JWT_SECRET: TEST_JWT_SECRET,
    DATA_ENCRYPTION_KEY: TEST_DATA_KEY,
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
    AUTH_INTERNAL_URL: "http://auth:9999",
    PUBLIC_URL: TEST_PUBLIC_URL,
    AUTH_APPLE_ENABLED: false,
    AUTH_GOOGLE_ENABLED: false,
    SMTP_HOST: "mail",
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    MAIL_FROM: "noreply@tinyglow.test",
    // Every first album is a family start from 127.0.0.1: never trip the network cap by accident.
    FAMILIES_PER_IP_PER_DAY: 100000,
    ...overrides,
  };
}

export interface TokenOptions {
  sub?: string;
  email?: string | null;
  sessionId?: string | null;
  role?: string;
  secret?: string;
  issuer?: string;
  audience?: string;
  /** Seconds since epoch. */
  iat?: number;
  /** Seconds since epoch. */
  exp?: number;
  alg?: "HS256" | "HS384";
  extra?: Record<string, unknown>;
}

/** Sign an access token the way GoTrue does (HS256, iss `${PUBLIC_URL}/auth`, aud authenticated). */
export async function signAccessToken(opts: TokenOptions = {}): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    role: opts.role ?? "authenticated",
    ...(opts.sub === undefined ? { sub: randomUUID() } : opts.sub ? { sub: opts.sub } : {}),
    ...(opts.email === null ? {} : { email: opts.email ?? "user@example.com" }),
    ...(opts.sessionId === null ? {} : { session_id: opts.sessionId ?? randomUUID() }),
    ...opts.extra,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "HS256", typ: "JWT" })
    .setIssuer(opts.issuer ?? `${TEST_PUBLIC_URL}/auth`)
    .setAudience(opts.audience ?? "authenticated")
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 3600)
    .sign(new TextEncoder().encode(opts.secret ?? TEST_JWT_SECRET));
}

/** A hand-built `alg: none` token (unsigned). */
export function unsignedToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
}

/**
 * Everything the real `createGoTrueClient` implements (step 9 adds the review links, step 13 the
 * passkey routes).
 */
export type FullGoTrueClient = GoTrueClient & GoTrueReviewLinks & GoTruePasskeys;

export type GoTrueStub = FullGoTrueClient & {
  calls: Record<keyof FullGoTrueClient, unknown[][]>;
  /** Behaviour per method; assign to change what GoTrue answers mid-test. */
  impl: Partial<FullGoTrueClient>;
};

/** The seven passkey methods (docs/plans/step-13.md 2.4), in the order `GoTruePasskeys` lists them. */
export const PASSKEY_METHODS = [
  "passkeyAuthOptions",
  "passkeyAuthVerify",
  "passkeyRegOptions",
  "passkeyRegVerify",
  "passkeyList",
  "passkeyRename",
  "passkeyDelete",
] as const satisfies readonly (keyof GoTruePasskeys)[];

export interface StubGoTrueOptions {
  /**
   * Default true: the stub has `adminGenerateMagicLink`, like the real client. `false` leaves the
   * method off the object (it is still in `calls`/`impl` for typing, never called), so
   * `hasReviewLinks` is false: the review sign-in's fail-closed 503 path.
   */
  reviewLinks?: boolean;
  /**
   * Default true: the stub has the seven passkey methods, like the real client. `false` leaves
   * them off the object (a pre-step-13 client), so `hasPasskeys` is false: every passkey route's
   * fail-closed 503 path.
   */
  passkeys?: boolean;
}

// GoTrue wire shapes (v2.197.0, docs/plans/step-13.md 0.1): what the stub's helpers below answer
// with, so tests exercise the API's conversions (Unix-seconds `expires_at` -> ISO, bare list
// array, absent `friendly_name` / `last_used_at`).

/** `{ challenge_id, options, expires_at: <Unix seconds> }` as GoTrue's options routes answer. */
export function goTruePasskeyOptionsBody(
  over: Partial<{
    challenge_id: string;
    options: Record<string, unknown>;
    expires_at: number;
  }> = {},
) {
  return {
    challenge_id: over.challenge_id ?? randomUUID(),
    options: over.options ?? {
      challenge: "dGVzdC1jaGFsbGVuZ2U",
      rpId: "localhost",
      userVerification: "preferred",
      timeout: 300000,
    },
    // GoTrue: int64 Unix seconds, never ISO.
    expires_at: over.expires_at ?? Math.floor(Date.now() / 1000) + 300,
  };
}

/** One GoTrue passkey item (`GET /passkeys/` entry, registration verify / PATCH response). */
export function goTruePasskeyBody(
  over: Partial<{
    id: string;
    friendly_name: string | null;
    created_at: string;
    last_used_at: string | null;
  }> = {},
) {
  return {
    id: over.id ?? randomUUID(),
    ...(over.friendly_name === undefined
      ? {}
      : over.friendly_name === null
        ? {}
        : { friendly_name: over.friendly_name }),
    created_at: over.created_at ?? "2026-10-11T12:34:56.123456Z",
    ...(over.last_used_at ? { last_used_at: over.last_used_at } : {}),
  };
}

/**
 * A recording GoTrue client (`GoTrueClient` + `GoTrueReviewLinks` + `GoTruePasskeys`).
 * `stub.calls.<method>` lists the argument arrays of every call. By default `sendOtp`, `logout` and
 * `adminDeleteUser` succeed and every other method (including `adminGenerateMagicLink` and the seven
 * passkey methods) throws (a test must say what GoTrue does); pass `impl` to override any of them.
 */
export function stubGoTrue(
  initial: Partial<FullGoTrueClient> = {},
  opts: StubGoTrueOptions = {},
): GoTrueStub {
  const impl: Partial<FullGoTrueClient> = { ...initial };
  const calls: GoTrueStub["calls"] = {
    sendOtp: [],
    verify: [],
    exchangePkce: [],
    signInWithIdToken: [],
    refresh: [],
    logout: [],
    adminDeleteUser: [],
    adminGenerateMagicLink: [],
    passkeyAuthOptions: [],
    passkeyAuthVerify: [],
    passkeyRegOptions: [],
    passkeyRegVerify: [],
    passkeyList: [],
    passkeyRename: [],
    passkeyDelete: [],
  };
  const defaults: Record<string, (...a: never[]) => Promise<unknown>> = {
    sendOtp: async () => undefined,
    logout: async () => undefined,
    adminDeleteUser: async () => undefined,
  };
  const passkeyNames = new Set<string>(PASSKEY_METHODS);
  const client: Record<string, unknown> = {};
  for (const name of Object.keys(calls) as (keyof FullGoTrueClient)[]) {
    if (name === "adminGenerateMagicLink" && opts.reviewLinks === false) continue;
    if (passkeyNames.has(name) && opts.passkeys === false) continue;
    client[name] = async (...args: unknown[]) => {
      calls[name].push(args);
      const fn = (impl[name] ?? defaults[name]) as
        | ((...a: unknown[]) => Promise<unknown>)
        | undefined;
      if (!fn) throw new Error(`unexpected GoTrue call: ${name}`);
      return fn(...args);
    };
  }
  return Object.assign(client as unknown as FullGoTrueClient, { calls, impl });
}

export async function gotrueSession(
  opts: TokenOptions & { refreshToken?: string } = {},
): Promise<GoTrueSession> {
  const sub = opts.sub ?? randomUUID();
  const email = opts.email === undefined ? "user@example.com" : opts.email;
  return {
    accessToken: await signAccessToken({ ...opts, sub, email }),
    refreshToken: opts.refreshToken ?? `rt-${randomUUID()}`,
    expiresIn: 3600,
    user: { id: sub, email },
  };
}
