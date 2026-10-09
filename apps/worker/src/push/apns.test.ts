import { verify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApnsMock, decodeJwt, pushTestKeys, startApnsMock } from "../testing/push-mocks";
import { recordingLog } from "../testing/stubs";
import {
  APNS_EXPIRATION_SEC,
  APNS_JWT_TTL_MS,
  apnsKeyPem,
  apnsPayload,
  createApnsClient,
} from "./apns";
import type { PushMessage } from "./types";

// APNs adapter against a local cleartext HTTP/2 mock (docs/plans/step-9.md 2.15). Never contacts
// Apple.

const BABY = "00000000-0000-4000-8000-000000000100";
const LINK = "00000000-0000-4000-8000-000000000200";
const msg: PushMessage = {
  title: "Littlelight",
  body: "3 new photos are ready to search.",
  data: { kind: "photos_analyzed", babyId: BABY },
  collapseId: `photos_analyzed:${BABY}`,
};
const hex = (prefix: string) => (prefix + "a".repeat(64)).slice(0, 64);

describe("apns", () => {
  let mock: ApnsMock;
  const keys = pushTestKeys();
  const opts = (extra: object = {}) => ({
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKeyPem: keys.ecPem,
    bundleId: "com.tesarsoft.littlelight",
    baseUrl: mock.baseUrl,
    ...extra,
  });

  beforeAll(async () => {
    mock = await startApnsMock();
  });
  afterAll(async () => {
    await mock.close();
  });

  it("sends a POST to /3/device/<token> with the documented headers and generic payload", async () => {
    const log = recordingLog();
    const client = createApnsClient(opts({ now: () => Date.now() }), log);
    const before = mock.seen.length;
    expect(await client.send(hex("c0ffee"), msg)).toBe("sent");
    const seen = mock.seen[before];
    expect(seen?.headers[":method"]).toBe("POST");
    expect(seen?.headers[":path"]).toBe(`/3/device/${hex("c0ffee")}`);
    expect(seen?.headers["apns-topic"]).toBe("com.tesarsoft.littlelight");
    expect(seen?.headers["apns-push-type"]).toBe("alert");
    expect(seen?.headers["apns-priority"]).toBe("5");
    expect(seen?.headers["apns-collapse-id"]).toBe(`photos_analyzed:${BABY}`);
    expect(seen?.headers["content-type"]).toBe("application/json");
    const expiry = Number(seen?.headers["apns-expiration"]);
    expect(Math.abs(expiry - (Math.floor(Date.now() / 1000) + APNS_EXPIRATION_SEC))).toBeLessThan(
      10,
    );
    expect(JSON.parse(seen?.body ?? "")).toEqual({
      aps: {
        alert: { title: "Littlelight", body: "3 new photos are ready to search." },
        sound: "default",
      },
      ll: { kind: "photos_analyzed", babyId: BABY },
    });
    await client.close();
  });

  it("the payload for share_viewed carries ids only, never a name", async () => {
    const m: PushMessage = {
      title: "Littlelight",
      body: "Someone opened your shared album.",
      data: { kind: "share_viewed", babyId: BABY, shareLinkId: LINK },
      collapseId: `share_viewed:${BABY}`,
    };
    expect(JSON.parse(apnsPayload(m))).toEqual({
      aps: {
        alert: { title: "Littlelight", body: "Someone opened your shared album." },
        sound: "default",
      },
      ll: { kind: "share_viewed", babyId: BABY, shareLinkId: LINK },
    });
  });

  it("signs an ES256 provider JWT with kid=key id, iss=team id and a current iat", async () => {
    const client = createApnsClient(opts(), recordingLog());
    const before = mock.seen.length;
    await client.send(hex("c0ffee"), msg);
    const auth = String(mock.seen[before]?.headers.authorization);
    expect(auth.startsWith("bearer ")).toBe(true);
    const jwt = decodeJwt(auth.slice(7));
    expect(jwt.header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(jwt.payload.iss).toBe("TEAM123456");
    expect(Math.abs(Number(jwt.payload.iat) - Math.floor(Date.now() / 1000))).toBeLessThan(10);
    expect(
      verify(
        "sha256",
        jwt.signingInput,
        { key: keys.ec.publicKey, dsaEncoding: "ieee-p1363" },
        jwt.signature,
      ),
    ).toBe(true);
    await client.close();
  });

  it("reuses the JWT for 50 minutes, then signs a new one", async () => {
    let t = Date.parse("2026-10-09T10:00:00Z");
    const client = createApnsClient(opts({ now: () => t }), recordingLog());
    const start = mock.seen.length;
    await client.send(hex("c0ffee"), msg);
    t += APNS_JWT_TTL_MS - 1000;
    await client.send(hex("c0ffee"), msg);
    t += 2000;
    await client.send(hex("c0ffee"), msg);
    const auths = mock.seen.slice(start).map((s) => s.headers.authorization);
    expect(auths[0]).toBe(auths[1]);
    expect(auths[2]).not.toBe(auths[0]);
    expect(APNS_JWT_TTL_MS).toBe(50 * 60 * 1000);
    await client.close();
  });

  it("keeps one HTTP/2 session across sends", async () => {
    const sessionsBefore = mock.sessions;
    const client = createApnsClient(opts(), recordingLog());
    for (let i = 0; i < 4; i++) await client.send(hex("c0ffee"), msg);
    expect(mock.sessions - sessionsBefore).toBe(1);
    await client.close();
  });

  it("410 and 400 BadDeviceToken are invalid_token", async () => {
    const client = createApnsClient(opts(), recordingLog());
    expect(await client.send(hex("dead"), msg)).toBe("invalid_token");
    expect(await client.send(hex("bad0"), msg)).toBe("invalid_token");
    await client.close();
  });

  it("a 5xx is failed (not invalid_token), so the device is kept", async () => {
    const client = createApnsClient(opts(), recordingLog());
    expect(await client.send(hex("b00m"), msg)).toBe("failed");
    await client.close();
  });

  it("403 ExpiredProviderToken is failed and drops the cached JWT (the next send signs a new one)", async () => {
    let t = Date.parse("2026-10-09T10:00:00Z");
    const client = createApnsClient(opts({ now: () => t }), recordingLog());
    const start = mock.seen.length;
    expect(await client.send(hex("expd"), msg)).toBe("failed");
    t += 1000;
    expect(await client.send(hex("c0ffee"), msg)).toBe("sent");
    const auths = mock.seen.slice(start).map((s) => s.headers.authorization);
    expect(auths[1]).not.toBe(auths[0]);
    await client.close();
  });

  it("a request that never completes times out as failed", async () => {
    const client = createApnsClient(opts({ timeoutMs: 150 }), recordingLog());
    expect(await client.send(hex("hang"), msg)).toBe("failed");
    await client.close();
  });

  it("recovers after the connection drops: the next send opens a new session", async () => {
    const client = createApnsClient(opts(), recordingLog());
    expect(await client.send(hex("c0ffee"), msg)).toBe("sent");
    const sessions = mock.sessions;
    mock.dropSessions();
    await new Promise((r) => setTimeout(r, 50));
    expect(await client.send(hex("c0ffee"), msg)).toBe("sent");
    expect(mock.sessions).toBe(sessions + 1);
    await client.close();
  });

  it("an unreachable server is failed, never a throw", async () => {
    const client = createApnsClient(opts({ baseUrl: "http://127.0.0.1:1" }), recordingLog());
    expect(await client.send(hex("c0ffee"), msg)).toBe("failed");
    await client.close();
  });

  it("an unusable key is failed and logged without the key", async () => {
    const log = recordingLog();
    const client = createApnsClient(
      opts({ privateKeyPem: "-----BEGIN PRIVATE KEY-----\nbm9wZQ==\n-----END PRIVATE KEY-----\n" }),
      log,
    );
    expect(await client.send(hex("c0ffee"), msg)).toBe("failed");
    expect(JSON.stringify(log.lines)).not.toContain("bm9wZQ");
    await client.close();
  });

  it("after close() sends are failed and nothing is requested", async () => {
    const client = createApnsClient(opts(), recordingLog());
    await client.close();
    const before = mock.seen.length;
    expect(await client.send(hex("c0ffee"), msg)).toBe("failed");
    expect(mock.seen.length).toBe(before);
    await client.close();
  });

  it("never logs the device token, the JWT, the key or a payload", async () => {
    const log = recordingLog();
    const client = createApnsClient(opts(), log);
    await client.send(hex("dead"), msg);
    await client.send(hex("b00m"), msg);
    await client.send(hex("c0ffee"), msg);
    const text = JSON.stringify(log.lines);
    for (const secret of [
      hex("dead"),
      hex("b00m"),
      hex("c0ffee"),
      "eyJ",
      "PRIVATE KEY",
      "ready to search",
    ]) {
      expect(text).not.toContain(secret);
    }
    // what is logged: provider, kind, http status and the provider's fixed reason
    expect(log.lines.some((l) => l.obj.httpStatus === 410 && l.obj.reason === "Unregistered")).toBe(
      true,
    );
    await client.close();
  });
});

describe("apnsKeyPem", () => {
  it("accepts base64 of the .p8 PEM text", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    expect(apnsKeyPem(Buffer.from(pem).toString("base64"))).toBe(pem);
  });

  it("wraps a bare base64 key body into a PEM", () => {
    const body = "A".repeat(130);
    const pem = apnsKeyPem(body);
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(pem.trimEnd().endsWith("-----END PRIVATE KEY-----")).toBe(true);
    expect(
      pem
        .split("\n")
        .slice(1, -2)
        .every((l) => l.length <= 64),
    ).toBe(true);
  });
});
