import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

// Local mock servers for the push adapters (docs/plans/step-9.md 2.15). Nothing here ever
// contacts Apple or Google: the APNs mock is a cleartext HTTP/2 server on 127.0.0.1 (the adapter
// accepts an `http://` override outside production), the FCM mock serves the OAuth token endpoint
// and the HTTP v1 send endpoint on one HTTP/1.1 server. Behaviour is chosen by the device token's
// prefix, so a test needs no per-request setup:
//   dead...  APNs 410 Unregistered / FCM 404 UNREGISTERED
//   bad0...  APNs 400 BadDeviceToken / FCM 400 with a violation on message.token
//   b00m...  APNs 500 InternalServerError / FCM 503
//   expd...  APNs 403 ExpiredProviderToken (the next request, with a fresh JWT, succeeds)
//   hang...  never answers (timeout tests)
//   anything else: success.

export interface ApnsSeen {
  headers: http2.IncomingHttpHeaders;
  body: string;
  token: string;
}

export interface ApnsMock {
  baseUrl: string;
  seen: ApnsSeen[];
  sessions: number;
  /** Close every open stream's session (simulates a dropped connection / GOAWAY). */
  dropSessions(): void;
  close(): Promise<void>;
}

export async function startApnsMock(): Promise<ApnsMock> {
  const seen: ApnsSeen[] = [];
  const open = new Set<http2.ServerHttp2Session>();
  let expiredOnce = true;
  const server = http2.createServer();
  const mock: ApnsMock = {
    baseUrl: "",
    seen,
    sessions: 0,
    dropSessions() {
      for (const s of open) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
  server.on("session", (s) => {
    mock.sessions += 1;
    open.add(s);
    s.on("close", () => open.delete(s));
    s.on("error", () => undefined);
  });
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (c: Buffer) => {
      body += c;
    });
    stream.on("error", () => undefined);
    stream.on("end", () => {
      const token = decodeURIComponent(String(headers[":path"]).split("/").pop() ?? "");
      seen.push({ headers, body, token });
      const reply = (status: number, reason?: string) => {
        stream.respond({ ":status": status });
        stream.end(reason ? JSON.stringify({ reason }) : undefined);
      };
      if (token.startsWith("hang")) return;
      if (token.startsWith("dead")) return reply(410, "Unregistered");
      if (token.startsWith("bad0")) return reply(400, "BadDeviceToken");
      if (token.startsWith("b00m")) return reply(500, "InternalServerError");
      if (token.startsWith("expd") && expiredOnce) {
        expiredOnce = false;
        return reply(403, "ExpiredProviderToken");
      }
      reply(200);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}

export interface FcmSeen {
  url: string;
  authorization: string | undefined;
  body: string;
}

export interface FcmMock {
  baseUrl: string;
  tokenUrl: string;
  /** Requests to the send endpoint. */
  sent: FcmSeen[];
  /** Form bodies posted to the OAuth endpoint. */
  tokenRequests: string[];
  /** Change what the OAuth endpoint answers: HTTP status and `expires_in`. */
  oauth: { status: number; expiresIn: number; delayMs: number };
  /** When set, the send endpoint answers 401 once (then success). */
  failAuthOnce: boolean;
  close(): Promise<void>;
}

export async function startFcmMock(): Promise<FcmMock> {
  const mock: FcmMock = {
    baseUrl: "",
    tokenUrl: "",
    sent: [],
    tokenRequests: [],
    oauth: { status: 200, expiresIn: 3599, delayMs: 0 },
    failAuthOnce: false,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
    });
    req.on("end", () => {
      const json = (status: number, payload?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (req.url === "/token") {
        mock.tokenRequests.push(body);
        const answer = () =>
          mock.oauth.status === 200
            ? json(200, {
                access_token: `ya29.mock-access-${mock.tokenRequests.length}`,
                expires_in: mock.oauth.expiresIn,
                token_type: "Bearer",
              })
            : json(mock.oauth.status, { error: "invalid_grant" });
        if (mock.oauth.delayMs > 0) setTimeout(answer, mock.oauth.delayMs);
        else answer();
        return;
      }
      mock.sent.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      if (mock.failAuthOnce) {
        mock.failAuthOnce = false;
        return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
      }
      const token = (JSON.parse(body) as { message: { token: string } }).message.token;
      if (token.startsWith("hang")) return;
      if (token.startsWith("dead")) {
        return json(404, {
          error: {
            code: 404,
            status: "NOT_FOUND",
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "UNREGISTERED",
              },
            ],
          },
        });
      }
      if (token.startsWith("bad0")) {
        return json(400, {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [{ field: "message.token", description: "invalid" }],
              },
            ],
          },
        });
      }
      if (token.startsWith("b00m")) return json(503);
      json(200, { name: "projects/p/messages/1" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  mock.baseUrl = `http://127.0.0.1:${port}`;
  mock.tokenUrl = `http://127.0.0.1:${port}/token`;
  return mock;
}

/** Fresh throwaway keys: an ES256 `.p8` for APNs and an RS256 service-account key for FCM. */
export function pushTestKeys() {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    ec,
    rsa,
    ecPem: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    rsaPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Decode a compact JWT without verifying it. */
export function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h as string, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p as string, "base64url").toString()) as Record<
      string,
      unknown
    >,
    signingInput: Buffer.from(`${h}.${p}`),
    signature: Buffer.from(s as string, "base64url"),
  };
}
