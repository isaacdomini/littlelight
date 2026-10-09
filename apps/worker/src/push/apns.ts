import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { errorCategory } from "../clients";
import type { WorkerLog } from "../log-types";
import {
  PUSH_REQUEST_TIMEOUT_MS,
  type PushMessage,
  type PushSendStatus,
  safeReason,
} from "./types";

// APNs provider adapter (docs/plans/step-9.md 2.8): token-based auth over HTTP/2 with
// `node:http2`, no SDK. `POST /3/device/<token>` on `PUSH_APNS_BASE_URL` (default from
// `APNS_ENVIRONMENT`: sandbox or production), `authorization: bearer <ES256 JWT>` with
// iss = team id and kid = key id, re-signed every 50 minutes (Apple accepts 20–60). One HTTP/2
// session is kept open and re-created after an error, GOAWAY or close. Mock servers in tests use
// an `http://` override (cleartext HTTP/2); production requires https (`pushEnvSchema`).
//
// 410, or 400 `BadDeviceToken` / `Unregistered` ⇒ `invalid_token` (the device is disabled by
// `push_record_delivery`); 403 `ExpiredProviderToken` / `InvalidProviderToken` drops the cached
// JWT; anything else ⇒ `failed`. Never logged: the device token (it is in the request path), the
// JWT, the key, request or response bodies.

/** Re-sign the provider JWT after this long. */
export const APNS_JWT_TTL_MS = 50 * 60 * 1000;
/** `apns-expiration`: Apple stores an undeliverable notification for at most this long. */
export const APNS_EXPIRATION_SEC = 24 * 60 * 60;
/** Bytes of an error response read for the `reason` field. */
const MAX_RESPONSE_BYTES = 4096;

const INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered"]);
const PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

export interface ApnsOptions {
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM of the `.p8` key. */
  privateKeyPem: string;
  bundleId: string;
  /** Origin without a trailing slash, e.g. `https://api.sandbox.push.apple.com`. */
  baseUrl: string;
  timeoutMs?: number;
  /** Clock (ms); tests pin it. */
  now?: () => number;
  /** Session factory; tests may pass one with TLS options for a self-signed mock. */
  connect?: (authority: string) => http2.ClientHttp2Session;
}

export interface ApnsClient {
  send(token: string, msg: PushMessage): Promise<PushSendStatus>;
  close(): Promise<void>;
}

/**
 * The PEM of `APNS_PRIVATE_KEY_BASE64`: base64 of the `.p8` file (PEM text) or, tolerated, the
 * base64 key body itself (DER).
 */
export function apnsKeyPem(base64: string): string {
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN PRIVATE KEY-----")) return decoded;
  const body = base64.replace(/-/g, "+").replace(/_/g, "/");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** The JSON body Apple receives: generic alert text and opaque ids under `ll`. */
export function apnsPayload(msg: PushMessage): string {
  return JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body }, sound: "default" },
    ll: msg.data,
  });
}

interface ApnsResponse {
  status: number;
  reason: string | undefined;
}

export function createApnsClient(opts: ApnsOptions, log: WorkerLog): ApnsClient {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
  const connect = opts.connect ?? ((authority: string) => http2.connect(authority));

  let keyPromise: ReturnType<typeof importPKCS8> | undefined;
  let jwt: { value: string; issuedAt: number } | undefined;
  let session: http2.ClientHttp2Session | undefined;
  let closed = false;

  async function providerToken(): Promise<string> {
    const t = now();
    if (jwt && t - jwt.issuedAt < APNS_JWT_TTL_MS) return jwt.value;
    keyPromise ??= importPKCS8(opts.privateKeyPem, "ES256");
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await keyPromise;
    } catch (err) {
      keyPromise = undefined;
      throw err;
    }
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: opts.keyId })
      .setIssuer(opts.teamId)
      .setIssuedAt(Math.floor(t / 1000))
      .sign(key);
    jwt = { value, issuedAt: t };
    return value;
  }

  function getSession(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    const s = connect(opts.baseUrl);
    const forget = () => {
      if (session === s) session = undefined;
    };
    s.on("error", (err) => {
      forget();
      log.warn({ provider: "apns", err: errorCategory(err) }, "push: APNs connection error");
    });
    s.on("goaway", () => {
      forget();
      s.close();
    });
    s.on("close", forget);
    session = s;
    return s;
  }

  function post(token: string, bearer: string, msg: PushMessage): Promise<ApnsResponse> {
    return new Promise<ApnsResponse>((resolve, reject) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = getSession().request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(token)}`,
          authorization: `bearer ${bearer}`,
          "apns-topic": opts.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "5",
          "apns-collapse-id": msg.collapseId,
          "apns-expiration": String(Math.floor(now() / 1000) + APNS_EXPIRATION_SEC),
          "content-type": "application/json",
        });
      } catch (err) {
        reject(err);
        return;
      }
      let status = 0;
      const chunks: Buffer[] = [];
      let size = 0;
      req.setTimeout(timeoutMs, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(Object.assign(new Error("APNs request timed out"), { code: "ETIMEDOUT" }));
      });
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk: Buffer) => {
        if (size < MAX_RESPONSE_BYTES) {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      req.on("error", reject);
      req.on("end", () => {
        let reason: string | undefined;
        if (status !== 200 && size > 0) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              reason?: unknown;
            };
            reason = safeReason(parsed.reason);
          } catch {
            reason = undefined;
          }
        }
        resolve({ status, reason });
      });
      req.end(apnsPayload(msg));
    });
  }

  return {
    async send(token, msg) {
      if (closed) return "failed";
      const kind = msg.data.kind;
      let bearer: string;
      try {
        bearer = await providerToken();
      } catch (err) {
        log.error({ provider: "apns", kind, err: errorCategory(err) }, "push: APNs key unusable");
        return "failed";
      }
      let res: ApnsResponse;
      try {
        res = await post(token, bearer, msg);
      } catch (err) {
        log.warn({ provider: "apns", kind, err: errorCategory(err) }, "push: APNs request failed");
        return "failed";
      }
      if (res.status === 200) return "sent";
      const invalid =
        res.status === 410 ||
        (res.status === 400 && res.reason !== undefined && INVALID_TOKEN_REASONS.has(res.reason));
      if (
        res.status === 403 &&
        res.reason !== undefined &&
        PROVIDER_TOKEN_REASONS.has(res.reason)
      ) {
        jwt = undefined;
      }
      log.warn(
        {
          provider: "apns",
          kind,
          httpStatus: res.status,
          reason: res.reason,
          status: invalid ? "invalid_token" : "failed",
        },
        "push: APNs rejected the notification",
      );
      return invalid ? "invalid_token" : "failed";
    },
    async close() {
      closed = true;
      const s = session;
      session = undefined;
      if (!s || s.closed || s.destroyed) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          s.destroy();
          resolve();
        }, 2_000);
        s.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
