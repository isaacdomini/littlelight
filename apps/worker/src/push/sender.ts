import { PUSH_ENDPOINTS } from "@tinyglow/shared";
import type { WorkerLog } from "../log-types";
import { type ApnsClient, apnsKeyPem, createApnsClient } from "./apns";
import { createFcmClient, type FcmClient, parseFcmServiceAccount } from "./fcm";
import type { PushConfig, PushSender, PushSendStatus } from "./types";

// `createPushSender` (docs/plans/step-9.md 2.8):
// - `PUSH_PROVIDER=none` ⇒ every send is `unconfigured` (production default until keys exist).
// - `PUSH_PROVIDER=fake` ⇒ `fake` and one log line `{kind, provider}`; nothing leaves the host
//   (dev default). Refused in production: `pushEnvSchema` fails boot, and this factory falls back
//   to `unconfigured` with an error line if it is ever reached anyway.
// - `PUSH_PROVIDER=live` ⇒ APNs for `apns` devices when APNS_TEAM_ID/APNS_KEY_ID/
//   APNS_PRIVATE_KEY_BASE64 are set, FCM for `fcm` devices when FCM_PROJECT_ID/
//   FCM_SERVICE_ACCOUNT_BASE64 are set (and the JSON is a usable service account); a provider
//   without credentials is `unconfigured`.
// Boot logs name the mode and which providers are configured, never a value.

const unconfigured = async (): Promise<PushSendStatus> => "unconfigured";

/** The APNs origin for the config: the override, else sandbox or production. */
export function apnsBaseUrl(config: Pick<PushConfig, "PUSH_APNS_BASE_URL" | "APNS_ENVIRONMENT">) {
  return (
    config.PUSH_APNS_BASE_URL ??
    (config.APNS_ENVIRONMENT === "production"
      ? PUSH_ENDPOINTS.APNS_PRODUCTION
      : PUSH_ENDPOINTS.APNS_SANDBOX)
  );
}

export function createPushSender(config: PushConfig, log: WorkerLog): PushSender {
  if (config.PUSH_PROVIDER === "fake" && config.NODE_ENV === "production") {
    log.error({ pushProvider: "fake" }, "push: the fake provider is refused in production");
    return { mode: "none", send: unconfigured, close: async () => undefined };
  }
  if (config.PUSH_PROVIDER === "none") {
    log.info(
      { pushProvider: "none" },
      "push: no provider (deliveries are recorded as unconfigured)",
    );
    return { mode: "none", send: unconfigured, close: async () => undefined };
  }
  if (config.PUSH_PROVIDER === "fake") {
    log.info({ pushProvider: "fake" }, "push: fake provider (nothing is sent)");
    return {
      mode: "fake",
      async send(target, msg) {
        log.info({ kind: msg.data.kind, provider: target.provider }, "push: fake delivery");
        return "fake";
      },
      close: async () => undefined,
    };
  }

  let apns: ApnsClient | null = null;
  if (config.APNS_TEAM_ID && config.APNS_KEY_ID && config.APNS_PRIVATE_KEY_BASE64) {
    apns = createApnsClient(
      {
        teamId: config.APNS_TEAM_ID,
        keyId: config.APNS_KEY_ID,
        privateKeyPem: apnsKeyPem(config.APNS_PRIVATE_KEY_BASE64),
        bundleId: config.APNS_BUNDLE_ID,
        baseUrl: apnsBaseUrl(config),
      },
      log,
    );
  }
  let fcm: FcmClient | null = null;
  if (config.FCM_PROJECT_ID && config.FCM_SERVICE_ACCOUNT_BASE64) {
    const account = parseFcmServiceAccount(config.FCM_SERVICE_ACCOUNT_BASE64);
    if (account) {
      fcm = createFcmClient(
        {
          projectId: config.FCM_PROJECT_ID,
          serviceAccount: account,
          baseUrl: config.PUSH_FCM_BASE_URL ?? PUSH_ENDPOINTS.FCM,
          ...(config.PUSH_OAUTH_TOKEN_URL ? { tokenUrl: config.PUSH_OAUTH_TOKEN_URL } : {}),
        },
        log,
      );
    } else {
      log.error(
        { field: "FCM_SERVICE_ACCOUNT_BASE64" },
        "push: FCM service account is not a usable JSON key (FCM sends are unconfigured)",
      );
    }
  }
  log.info({ pushProvider: "live", apns: apns !== null, fcm: fcm !== null }, "push: live provider");
  return {
    mode: "live",
    async send(target, msg) {
      const client = target.provider === "apns" ? apns : fcm;
      if (!client) return "unconfigured";
      try {
        return await client.send(target.token, msg);
      } catch {
        return "failed";
      }
    },
    async close() {
      await Promise.all([apns?.close(), fcm?.close()]);
    },
  };
}
