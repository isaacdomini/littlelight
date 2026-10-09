import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApnsMock,
  type FcmMock,
  pushTestKeys,
  startApnsMock,
  startFcmMock,
} from "../testing/push-mocks";
import { recordingLog } from "../testing/stubs";
import { apnsBaseUrl, createPushSender } from "./sender";
import type { PushConfig, PushMessage } from "./types";

const BABY = "00000000-0000-4000-8000-000000000100";
const msg: PushMessage = {
  title: "Littlelight",
  body: "3 new photos are ready to search.",
  data: { kind: "photos_analyzed", babyId: BABY },
  collapseId: `photos_analyzed:${BABY}`,
};
const base: PushConfig = {
  PUSH_PROVIDER: "none",
  APNS_BUNDLE_ID: "com.tesarsoft.littlelight",
  APNS_ENVIRONMENT: "sandbox",
  NODE_ENV: "development",
};
const IOS = { provider: "apns" as const, token: "a".repeat(64) };
const ANDROID = { provider: "fcm" as const, token: `c0ffee:APA91b-${"x".repeat(30)}` };

describe("createPushSender: none and fake", () => {
  it("none records every send as unconfigured and says so once at boot", async () => {
    const log = recordingLog();
    const s = createPushSender(base, log);
    expect(s.mode).toBe("none");
    expect(await s.send(IOS, msg)).toBe("unconfigured");
    expect(await s.send(ANDROID, msg)).toBe("unconfigured");
    expect(log.lines.filter((l) => l.level === "info")).toHaveLength(1);
    await s.close();
  });

  it("fake sends nothing, answers fake and logs only {kind, provider}", async () => {
    const log = recordingLog();
    const s = createPushSender({ ...base, PUSH_PROVIDER: "fake" }, log);
    expect(s.mode).toBe("fake");
    expect(await s.send(IOS, msg)).toBe("fake");
    const line = log.lines.find((l) => l.msg === "push: fake delivery");
    expect(line?.obj).toEqual({ kind: "photos_analyzed", provider: "apns" });
    const text = JSON.stringify(log.lines);
    expect(text).not.toContain(IOS.token);
    expect(text).not.toContain("ready to search");
  });

  it("fake is refused in production: unconfigured, with an error line", async () => {
    const log = recordingLog();
    const s = createPushSender({ ...base, PUSH_PROVIDER: "fake", NODE_ENV: "production" }, log);
    expect(s.mode).toBe("none");
    expect(await s.send(IOS, msg)).toBe("unconfigured");
    expect(log.lines.some((l) => l.level === "error")).toBe(true);
  });
});

describe("createPushSender: live", () => {
  let apns: ApnsMock;
  let fcm: FcmMock;
  const keys = pushTestKeys();
  const account = Buffer.from(
    JSON.stringify({
      client_email: "push@ll-mock.iam.gserviceaccount.com",
      private_key: keys.rsaPem,
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  ).toString("base64");
  const full = (): PushConfig => ({
    ...base,
    PUSH_PROVIDER: "live",
    APNS_TEAM_ID: "TEAM123456",
    APNS_KEY_ID: "KEY1234567",
    APNS_PRIVATE_KEY_BASE64: Buffer.from(keys.ecPem).toString("base64"),
    FCM_PROJECT_ID: "ll-mock",
    FCM_SERVICE_ACCOUNT_BASE64: account,
    PUSH_APNS_BASE_URL: apns.baseUrl,
    PUSH_FCM_BASE_URL: fcm.baseUrl,
    PUSH_OAUTH_TOKEN_URL: fcm.tokenUrl,
  });

  beforeAll(async () => {
    apns = await startApnsMock();
    fcm = await startFcmMock();
  });
  afterAll(async () => {
    await apns.close();
    await fcm.close();
  });

  it("routes apns devices to APNs and fcm devices to FCM", async () => {
    const s = createPushSender(full(), recordingLog());
    expect(s.mode).toBe("live");
    const a = apns.seen.length;
    const f = fcm.sent.length;
    expect(await s.send(IOS, msg)).toBe("sent");
    expect(apns.seen.length).toBe(a + 1);
    expect(fcm.sent.length).toBe(f);
    expect(await s.send(ANDROID, msg)).toBe("sent");
    expect(fcm.sent.length).toBe(f + 1);
    await s.close();
  });

  it("passes provider verdicts through (invalid_token, failed)", async () => {
    const s = createPushSender(full(), recordingLog());
    expect(await s.send({ provider: "apns", token: `dead${"a".repeat(60)}` }, msg)).toBe(
      "invalid_token",
    );
    expect(await s.send({ provider: "fcm", token: `dead:APA91b-${"x".repeat(30)}` }, msg)).toBe(
      "invalid_token",
    );
    expect(await s.send({ provider: "apns", token: `b00m${"a".repeat(60)}` }, msg)).toBe("failed");
    await s.close();
  });

  it("a provider without credentials is unconfigured and never contacts anything", async () => {
    const apnsOnly = { ...full() };
    delete apnsOnly.FCM_PROJECT_ID;
    delete apnsOnly.FCM_SERVICE_ACCOUNT_BASE64;
    const s = createPushSender(apnsOnly, recordingLog());
    const f = fcm.sent.length;
    expect(await s.send(ANDROID, msg)).toBe("unconfigured");
    expect(fcm.sent.length).toBe(f);
    expect(await s.send(IOS, msg)).toBe("sent");
    await s.close();

    const fcmOnly = { ...full() };
    delete fcmOnly.APNS_TEAM_ID;
    const t = createPushSender(fcmOnly, recordingLog());
    const a = apns.seen.length;
    expect(await t.send(IOS, msg)).toBe("unconfigured");
    expect(apns.seen.length).toBe(a);
    await t.close();
  });

  it("live with no credentials at all: every send is unconfigured", async () => {
    const s = createPushSender({ ...base, PUSH_PROVIDER: "live" }, recordingLog());
    expect(await s.send(IOS, msg)).toBe("unconfigured");
    expect(await s.send(ANDROID, msg)).toBe("unconfigured");
  });

  it("an FCM service account that is not usable JSON is unconfigured with an error line naming the field only", async () => {
    const log = recordingLog();
    const s = createPushSender(
      { ...full(), FCM_SERVICE_ACCOUNT_BASE64: Buffer.from("not json at all").toString("base64") },
      log,
    );
    expect(await s.send(ANDROID, msg)).toBe("unconfigured");
    const err = log.lines.find((l) => l.level === "error");
    expect(err?.obj).toEqual({ field: "FCM_SERVICE_ACCOUNT_BASE64" });
    expect(JSON.stringify(log.lines)).not.toContain("not json at all");
    await s.close();
  });

  it("boot logs name which providers are configured, never a value", () => {
    const log = recordingLog();
    createPushSender(full(), log);
    const boot = log.lines.find((l) => l.msg === "push: live provider");
    expect(boot?.obj).toEqual({ pushProvider: "live", apns: true, fcm: true });
    const text = JSON.stringify(log.lines);
    for (const v of ["TEAM123456", "KEY1234567", "PRIVATE KEY", "ll-mock", apns.baseUrl]) {
      expect(text).not.toContain(v);
    }
  });

  it("close() closes both providers and may be called twice", async () => {
    const s = createPushSender(full(), recordingLog());
    await s.send(IOS, msg);
    await s.close();
    await s.close();
  });
});

describe("apnsBaseUrl", () => {
  it("defaults from the environment and honours the override", () => {
    expect(apnsBaseUrl({ APNS_ENVIRONMENT: "sandbox" })).toBe("https://api.sandbox.push.apple.com");
    expect(apnsBaseUrl({ APNS_ENVIRONMENT: "production" })).toBe("https://api.push.apple.com");
    expect(
      apnsBaseUrl({ APNS_ENVIRONMENT: "production", PUSH_APNS_BASE_URL: "http://127.0.0.1:9" }),
    ).toBe("http://127.0.0.1:9");
  });
});
