import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { errorCategory } from "../clients";
import type { WorkerLog } from "../log-types";
import {
  PUSH_REQUEST_TIMEOUT_MS,
  type PushMessage,
  type PushSendStatus,
  safeReason,
} from "./types";

// FCM HTTP v1 adapter (docs/plans/step-9.md 2.8), no Firebase SDK. A service-account JWT (RS256,
// scope firebase.messaging, aud = the account's `token_uri`) is exchanged at
// `PUSH_OAUTH_TOKEN_URL` (default: the account's `token_uri`) for an OAuth access token, cached
// until a minute before it expires (single flight). Messages go to
// `${PUSH_FCM_BASE_URL}/v1/projects/<FCM_PROJECT_ID>/messages:send`.
//
// 404 `UNREGISTERED`, or 400 with a field violation on `message.token` ⇒ `invalid_token`; 401
// drops the cached access token; anything else ⇒ `failed`. Never logged: the device token, the
// service-account key, the assertion, the access token, request or response bodies.

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URI_DEFAULT = "https://oauth2.googleapis.com/token";
/** Assertion lifetime (Google's maximum). */
const ASSERTION_TTL_SEC = 3600;
/** Refresh the access token this long before Google says it expires. */
const ACCESS_TOKEN_SLACK_MS = 60_000;
const MAX_RESPONSE_BYTES = 16_384;

/** The fields of the service-account JSON this adapter needs. */
export const fcmServiceAccountSchema = z.object({
  client_email: z.string().min(3).max(320).includes("@"),
  private_key: z.string().includes("PRIVATE KEY"),
  token_uri: z.url({ protocol: /^https?$/ }).optional(),
});
export type FcmServiceAccount = z.infer<typeof fcmServiceAccountSchema>;

/** Parse `FCM_SERVICE_ACCOUNT_BASE64`; null when it is not a usable service-account JSON. */
export function parseFcmServiceAccount(base64: string): FcmServiceAccount | null {
  try {
    const json: unknown = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    const parsed = fcmServiceAccountSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface FcmOptions {
  projectId: string;
  serviceAccount: FcmServiceAccount;
  /** Origin without a trailing slash (default `https://fcm.googleapis.com`). */
  baseUrl: string;
  /** Where the assertion is exchanged (default: the account's `token_uri`). */
  tokenUrl?: string;
  timeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export interface FcmClient {
  send(token: string, msg: PushMessage): Promise<PushSendStatus>;
  close(): Promise<void>;
}

/** The FCM `message` for one device: generic notification text, ids as string data. */
export function fcmMessage(token: string, msg: PushMessage): object {
  const data: Record<string, string> = { kind: msg.data.kind, babyId: msg.data.babyId };
  if (msg.data.kind === "share_viewed") data.shareLinkId = msg.data.shareLinkId;
  return {
    message: {
      token,
      notification: { title: msg.title, body: msg.body },
      data,
      android: {
        priority: "NORMAL",
        collapse_key: msg.collapseId,
        notification: { channel_id: "default" },
      },
    },
  };
}

interface FcmErrorBody {
  error?: {
    status?: unknown;
    details?: Array<{
      errorCode?: unknown;
      fieldViolations?: Array<{ field?: unknown }>;
    }>;
  };
}

/** `{errorCode, tokenField}` of an FCM error response (no free text). */
export function fcmErrorInfo(body: unknown): { errorCode?: string; tokenField: boolean } {
  const details = (body as FcmErrorBody | null)?.error?.details;
  let errorCode: string | undefined;
  let tokenField = false;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (errorCode === undefined && typeof d?.errorCode === "string") {
        errorCode = safeReason(d.errorCode);
      }
      if (Array.isArray(d?.fieldViolations)) {
        for (const v of d.fieldViolations) if (v?.field === "message.token") tokenField = true;
      }
    }
  }
  if (errorCode === undefined) {
    errorCode = safeReason((body as FcmErrorBody | null)?.error?.status);
  }
  return { ...(errorCode !== undefined ? { errorCode } : {}), tokenField };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createFcmClient(opts: FcmOptions, log: WorkerLog): FcmClient {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  const audience = opts.serviceAccount.token_uri ?? GOOGLE_TOKEN_URI_DEFAULT;
  const tokenUrl = opts.tokenUrl ?? audience;
  const sendUrl = `${opts.baseUrl}/v1/projects/${encodeURIComponent(opts.projectId)}/messages:send`;

  let keyPromise: ReturnType<typeof importPKCS8> | undefined;
  let access: { value: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    keyPromise ??= importPKCS8(opts.serviceAccount.private_key, "RS256");
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await keyPromise;
    } catch (err) {
      keyPromise = undefined;
      throw err;
    }
    const iat = Math.floor(now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(opts.serviceAccount.client_email)
      .setAudience(audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ASSERTION_TTL_SEC)
      .sign(key);
    const res = await doFetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await readJson(res)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!res.ok || typeof body?.access_token !== "string" || body.access_token.length === 0) {
      throw Object.assign(new Error("FCM OAuth token exchange failed"), {
        code: `oauth_${res.status}`,
      });
    }
    const expiresIn =
      typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    access = {
      value: body.access_token,
      expiresAt: now() + expiresIn * 1000 - ACCESS_TOKEN_SLACK_MS,
    };
    return access.value;
  }

  function accessToken(): Promise<string> {
    if (access && now() < access.expiresAt) return Promise.resolve(access.value);
    inflight ??= exchange().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return {
    async send(token, msg) {
      const kind = msg.data.kind;
      let bearer: string;
      try {
        bearer = await accessToken();
      } catch (err) {
        log.warn({ provider: "fcm", kind, err: errorCategory(err) }, "push: FCM auth failed");
        return "failed";
      }
      let res: Response;
      try {
        res = await doFetch(sendUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify(fcmMessage(token, msg)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        log.warn({ provider: "fcm", kind, err: errorCategory(err) }, "push: FCM request failed");
        return "failed";
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return "sent";
      }
      const info = fcmErrorInfo(await readJson(res).catch(() => null));
      const invalid =
        (res.status === 404 && info.errorCode === "UNREGISTERED") ||
        (res.status === 400 && info.tokenField);
      if (res.status === 401) access = undefined;
      log.warn(
        {
          provider: "fcm",
          kind,
          httpStatus: res.status,
          reason: info.errorCode,
          status: invalid ? "invalid_token" : "failed",
        },
        "push: FCM rejected the notification",
      );
      return invalid ? "invalid_token" : "failed";
    },
    async close() {
      access = undefined;
    },
  };
}
