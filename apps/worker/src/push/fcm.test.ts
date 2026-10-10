import { verify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeJwt, type FcmMock, pushTestKeys, startFcmMock } from "../testing/push-mocks";
import { recordingLog } from "../testing/stubs";
import {
  createFcmClient,
  FCM_SCOPE,
  fcmErrorInfo,
  fcmMessage,
  parseFcmServiceAccount,
} from "./fcm";
import type { PushMessage } from "./types";

// FCM HTTP v1 adapter against local OAuth + send mocks (docs/plans/step-9.md 2.15). Never
// contacts Google.

const BABY = "00000000-0000-4000-8000-000000000100";
const LINK = "00000000-0000-4000-8000-000000000200";
const share: PushMessage = {
  title: "Tinyglow",
  body: "Someone opened your shared album.",
  data: { kind: "share_viewed", babyId: BABY, shareLinkId: LINK },
  collapseId: `share_viewed:${BABY}`,
};
const photos: PushMessage = {
  title: "Tinyglow",
  body: "3 new photos are ready to search.",
  data: { kind: "photos_analyzed", babyId: BABY },
  collapseId: `photos_analyzed:${BABY}`,
};
const TOKEN = (p: string) => `${p}:APA91b-${"x".repeat(40)}`;

describe("fcm", () => {
  let mock: FcmMock;
  const keys = pushTestKeys();
  const account = {
    client_email: "push@ll-mock.iam.gserviceaccount.com",
    private_key: keys.rsaPem,
    token_uri: "https://oauth2.googleapis.com/token",
  };
  const opts = (extra: object = {}) => ({
    projectId: "ll-mock",
    serviceAccount: account,
    baseUrl: mock.baseUrl,
    tokenUrl: mock.tokenUrl,
    ...extra,
  });

  beforeAll(async () => {
    mock = await startFcmMock();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.sent.length = 0;
    mock.tokenRequests.length = 0;
    mock.oauth.status = 200;
    mock.oauth.expiresIn = 3599;
    mock.oauth.delayMs = 0;
    mock.failAuthOnce = false;
  });

  it("exchanges an RS256 service-account assertion at the token URL, then sends with the bearer", async () => {
    const client = createFcmClient(opts(), recordingLog());
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("sent");
    expect(mock.tokenRequests).toHaveLength(1);
    const form = new URLSearchParams(mock.tokenRequests[0]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = decodeJwt(form.get("assertion") ?? "");
    expect(jwt.header.alg).toBe("RS256");
    expect(jwt.payload).toMatchObject({
      iss: account.client_email,
      aud: account.token_uri,
      scope: FCM_SCOPE,
    });
    expect(Number(jwt.payload.exp) - Number(jwt.payload.iat)).toBe(3600);
    expect(verify("sha256", jwt.signingInput, keys.rsa.publicKey, jwt.signature)).toBe(true);
    expect(mock.sent[0]?.authorization).toBe("Bearer ya29.mock-access-1");
    expect(mock.sent[0]?.url).toBe("/v1/projects/ll-mock/messages:send");
  });

  it("sends the generic notification and id-only string data with the collapse key", async () => {
    const client = createFcmClient(opts(), recordingLog());
    await client.send(TOKEN("c0ffee"), share);
    expect(JSON.parse(mock.sent[0]?.body ?? "")).toEqual({
      message: {
        token: TOKEN("c0ffee"),
        notification: { title: "Tinyglow", body: "Someone opened your shared album." },
        data: { kind: "share_viewed", babyId: BABY, shareLinkId: LINK },
        android: {
          priority: "NORMAL",
          collapse_key: `share_viewed:${BABY}`,
          notification: { channel_id: "default" },
        },
      },
    });
    const m = fcmMessage("t".repeat(10), photos) as { message: { data: Record<string, string> } };
    expect(m.message.data).toEqual({ kind: "photos_analyzed", babyId: BABY });
    expect(Object.values(m.message.data).every((v) => typeof v === "string")).toBe(true);
  });

  it("caches the access token (one exchange for many sends) and refreshes a minute before expiry", async () => {
    let t = Date.parse("2026-10-09T10:00:00Z");
    const client = createFcmClient(opts({ now: () => t }), recordingLog());
    await client.send(TOKEN("c0ffee"), share);
    await client.send(TOKEN("c0ffee"), share);
    expect(mock.tokenRequests).toHaveLength(1);
    t += (3599 - 60) * 1000 - 1;
    await client.send(TOKEN("c0ffee"), share);
    expect(mock.tokenRequests).toHaveLength(1);
    t += 2;
    await client.send(TOKEN("c0ffee"), share);
    expect(mock.tokenRequests).toHaveLength(2);
    expect(mock.sent[3]?.authorization).toBe("Bearer ya29.mock-access-2");
  });

  it("concurrent first sends share one token exchange (single flight)", async () => {
    mock.oauth.delayMs = 50;
    const client = createFcmClient(opts(), recordingLog());
    const out = await Promise.all([1, 2, 3, 4].map(() => client.send(TOKEN("c0ffee"), share)));
    expect(out).toEqual(["sent", "sent", "sent", "sent"]);
    expect(mock.tokenRequests).toHaveLength(1);
  });

  it("404 UNREGISTERED and 400 on message.token are invalid_token; 503 is failed", async () => {
    const client = createFcmClient(opts(), recordingLog());
    expect(await client.send(TOKEN("dead"), share)).toBe("invalid_token");
    expect(await client.send(TOKEN("bad0"), share)).toBe("invalid_token");
    expect(await client.send(TOKEN("b00m"), share)).toBe("failed");
  });

  it("a 401 on send drops the cached access token so the next send re-authenticates", async () => {
    const client = createFcmClient(opts(), recordingLog());
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("sent");
    mock.failAuthOnce = true;
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("failed");
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("sent");
    expect(mock.tokenRequests).toHaveLength(2);
  });

  it("an OAuth failure is failed (not invalid_token), without sending", async () => {
    mock.oauth.status = 400;
    const client = createFcmClient(opts(), recordingLog());
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("failed");
    expect(mock.sent).toHaveLength(0);
    mock.oauth.status = 200;
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("sent");
  });

  it("a request that never completes times out as failed", async () => {
    const client = createFcmClient(opts({ timeoutMs: 150 }), recordingLog());
    expect(await client.send(TOKEN("hang"), share)).toBe("failed");
  });

  it("an unreachable server is failed, never a throw", async () => {
    const client = createFcmClient(opts({ baseUrl: "http://127.0.0.1:1" }), recordingLog());
    expect(await client.send(TOKEN("c0ffee"), share)).toBe("failed");
  });

  it("the token URL defaults to the account's token_uri", async () => {
    const seen: string[] = [];
    const client = createFcmClient(
      {
        projectId: "ll-mock",
        serviceAccount: account,
        baseUrl: mock.baseUrl,
        fetch: (async (url: string) => {
          seen.push(String(url));
          return new Response(JSON.stringify({ access_token: "a", expires_in: 3000 }), {
            status: 200,
          });
        }) as never,
      },
      recordingLog(),
    );
    await client.send(TOKEN("c0ffee"), share);
    expect(seen[0]).toBe(account.token_uri);
    expect(seen[1]).toBe(`${mock.baseUrl}/v1/projects/ll-mock/messages:send`);
  });

  it("never logs the device token, the key, the assertion or the access token", async () => {
    const log = recordingLog();
    const client = createFcmClient(opts(), log);
    await client.send(TOKEN("dead"), share);
    await client.send(TOKEN("b00m"), share);
    await client.send(TOKEN("c0ffee"), share);
    mock.oauth.status = 500;
    const second = createFcmClient(opts(), log);
    await second.send(TOKEN("c0ffee"), share);
    const text = JSON.stringify(log.lines);
    for (const secret of ["APA91b", "ya29", "PRIVATE KEY", "eyJ", "opened your shared"]) {
      expect(text).not.toContain(secret);
    }
    expect(log.lines.some((l) => l.obj.httpStatus === 404 && l.obj.reason === "UNREGISTERED")).toBe(
      true,
    );
  });

  it("close() is safe to call repeatedly", async () => {
    const client = createFcmClient(opts(), recordingLog());
    await client.close();
    await client.close();
  });
});

describe("parseFcmServiceAccount", () => {
  const sa = {
    client_email: "a@b.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
    extra: 1,
  };
  const b64 = (o: unknown) =>
    Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");

  it("accepts a usable key and keeps only the needed fields", () => {
    const parsed = parseFcmServiceAccount(
      b64({ ...sa, token_uri: "https://oauth2.googleapis.com/token" }),
    );
    expect(parsed).toEqual({
      client_email: sa.client_email,
      private_key: sa.private_key,
      token_uri: "https://oauth2.googleapis.com/token",
    });
  });

  it.each([
    ["not JSON", b64("not json")],
    ["no private key", b64({ client_email: sa.client_email })],
    ["a key without PRIVATE KEY", b64({ ...sa, private_key: "nope" })],
    ["a bad email", b64({ ...sa, client_email: "x" })],
    ["a bad token_uri", b64({ ...sa, token_uri: "ftp://x" })],
    ["an empty string", ""],
  ])("returns null for %s", (_n, input) => {
    expect(parseFcmServiceAccount(input)).toBeNull();
  });
});

describe("fcmErrorInfo", () => {
  it("reads the FCM errorCode, then falls back to the status", () => {
    expect(fcmErrorInfo({ error: { details: [{ errorCode: "UNREGISTERED" }] } })).toEqual({
      errorCode: "UNREGISTERED",
      tokenField: false,
    });
    expect(fcmErrorInfo({ error: { status: "UNAVAILABLE" } })).toEqual({
      errorCode: "UNAVAILABLE",
      tokenField: false,
    });
  });

  it("flags a violation on message.token only", () => {
    expect(
      fcmErrorInfo({ error: { details: [{ fieldViolations: [{ field: "message.token" }] }] } })
        .tokenField,
    ).toBe(true);
    expect(
      fcmErrorInfo({ error: { details: [{ fieldViolations: [{ field: "message.data" }] }] } })
        .tokenField,
    ).toBe(false);
  });

  it("handles junk and drops free text", () => {
    expect(fcmErrorInfo(null)).toEqual({ tokenField: false });
    expect(fcmErrorInfo("x")).toEqual({ tokenField: false });
    expect(
      fcmErrorInfo({ error: { details: [{ errorCode: "has spaces and a token tok-123" }] } })
        .errorCode,
    ).toBe("other");
  });
});
