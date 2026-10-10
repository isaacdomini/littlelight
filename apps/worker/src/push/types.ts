import type { PushData, PushDeliveryStatus, PushEnv, PushProvider } from "@tinyglow/shared";

// Push sender contracts (docs/plans/step-9.md 2.8). Everything that reaches Apple or Google is a
// `PushMessage`: the generic text of `pushMessage(kind, count)` (D10: no baby name, link name,
// caption or parent text), opaque ids in `data`, and a collapse id built from the kind and the
// baby id. Device tokens, provider JWTs, OAuth access tokens, request bodies and responses are
// never logged: senders log the provider, the kind, the HTTP status and the provider's error
// code (a fixed vocabulary) only.

/** One notification as handed to a provider adapter. */
export interface PushMessage {
  title: string;
  body: string;
  data: PushData;
  /** APNs `apns-collapse-id` / FCM `collapse_key`: `${kind}:${babyId}` (≤ 64 bytes). */
  collapseId: string;
}

/** Outcome of one send; also the `push_deliveries.status` written for it. */
export type PushSendStatus = PushDeliveryStatus;

/** One device to notify. The token is a secret: never log it. */
export interface PushTarget {
  provider: PushProvider;
  token: string;
}

export interface PushSender {
  /** `PUSH_PROVIDER` this sender was built for. */
  readonly mode: PushEnv["PUSH_PROVIDER"];
  /**
   * Deliver one message to one device. Never throws: transport and provider errors resolve
   * `failed`, a dead token `invalid_token`, a provider without credentials `unconfigured`.
   */
  send(target: PushTarget, msg: PushMessage): Promise<PushSendStatus>;
  /** Close provider connections (HTTP/2 session). Safe to call more than once. */
  close(): Promise<void>;
}

/** The slice of the worker config the senders read (`pushEnvSchema`). */
export type PushConfig = Pick<
  PushEnv,
  | "PUSH_PROVIDER"
  | "APNS_TEAM_ID"
  | "APNS_KEY_ID"
  | "APNS_PRIVATE_KEY_BASE64"
  | "APNS_BUNDLE_ID"
  | "APNS_ENVIRONMENT"
  | "FCM_PROJECT_ID"
  | "FCM_SERVICE_ACCOUNT_BASE64"
  | "PUSH_APNS_BASE_URL"
  | "PUSH_FCM_BASE_URL"
  | "PUSH_OAUTH_TOKEN_URL"
  | "NODE_ENV"
>;

/** Per-request timeout of a provider call (APNs request, FCM token exchange, FCM send). */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

/** Provider error codes are a fixed vocabulary; anything else is logged as `other`. */
export function safeReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  return /^[A-Za-z_]{1,64}$/.test(reason) ? reason : "other";
}
