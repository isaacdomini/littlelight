import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { GOOGLE_PICKER_SCOPE, scopeIncludesPicker } from "@tinyglow/shared";
import { pino } from "pino";
import { z } from "zod";
import { buildFakeCatalogue, type FakeCatalogueItem } from "./fake-catalogue";

// Fake Google OAuth + Photos Picker server (docs/plans/step-10.md 2.9, task 10.7; D7).
//
// Plain `node:http`, in-memory state. Dev Compose runs it as `google-fake:8099`; unit and
// integration tests start it in-process on an ephemeral port (`startFakeGoogleServer`). It mimics
// only what the real flow touches, with the shapes of the shared schemas
// (`googleTokenResponseSchema`, `pickerSessionSchema`, `pickerMediaItemsPageSchema`), and mints
// `fake-access-…`, `fake-refresh-…`, `fake-code-…` values so the log scans catch a leak.
//
// Dev/test only: refused when `NODE_ENV=production` (CLI and library). Logs start/stop and handler
// error categories only: never a token, code, session id, URL, query string or request header,
// and no per-request lines (`/media/` paths must not appear in Compose logs).
//
// Test hooks (`/__fake/*`, no auth) and failure injection (`POST /__fake/faults`) are documented
// next to `FAKE_ROUTES` and `faultSchema` below.

export const FAKE_GOOGLE_DEFAULT_PORT = 8099;
/** Account used when the consent URL has no `account=` (and the consent hook sets none). */
export const FAKE_GOOGLE_DEFAULT_ACCOUNT = "fake-user";
/** Body size limit for POST requests (token, revoke, picker form, hooks). */
const MAX_BODY_BYTES = 64 * 1024;
/** Most recent requests kept for `GET /__fake/requests`. */
const MAX_RECORDED_REQUESTS = 2000;
/** Picker `pageSize` default and maximum (Google: default 25, max 100). */
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/** Routes failure injection can target. */
export const FAKE_ROUTES = [
  "auth",
  "token",
  "revoke",
  "sessions.create",
  "sessions.get",
  "sessions.delete",
  "mediaItems",
  "picker",
  "media",
] as const;
export type FakeRoute = (typeof FAKE_ROUTES)[number];

/**
 * One injected fault (`POST /__fake/faults`, a fault or an array). Matches the next request(s) to
 * `route` (optionally only for `itemId` — media/mediaItems —, `sessionId` or the token
 * `grantType`), consumed `times` times (default 1, or `"always"`). Effects, combinable:
 * - `delayMs`: wait before answering (slow response); alone it changes nothing else;
 * - `status` 400..599 (+ `error`, `retryAfter`): an error in the route's style (OAuth
 *   `{ error }` for token/revoke, Google `{ error: { code, status, message } }` otherwise).
 *   `error` alone means status 400 (`{ route: "token", grantType: "refresh_token", error:
 *   "invalid_grant" }`);
 * - `redirect`: `same-host` (302 to the same URL on the same origin) or `cross-host` (302 to the
 *   same path on another host: `localhost` ⇄ `127.0.0.1`, or `location`); `status` 301..308
 *   picks the code;
 * - media only: `truncateAfterBytes` (announce the full length, then drop the connection) and
 *   `stallMs` (send the first half, at most 64 KiB, stall, then the rest).
 */
export const faultSchema = z
  .strictObject({
    route: z.enum(FAKE_ROUTES),
    itemId: z.string().min(1).max(64).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    grantType: z.enum(["authorization_code", "refresh_token"]).optional(),
    status: z.number().int().min(301).max(599).optional(),
    error: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
    retryAfter: z.number().int().min(0).max(3600).optional(),
    delayMs: z.number().int().min(0).max(120_000).optional(),
    redirect: z.enum(["same-host", "cross-host"]).optional(),
    location: z.url({ protocol: /^https?$/ }).optional(),
    truncateAfterBytes: z.number().int().min(0).optional(),
    stallMs: z.number().int().min(0).max(120_000).optional(),
    times: z.union([z.number().int().min(1).max(10_000), z.literal("always")]).default(1),
  })
  .superRefine((f, ctx) => {
    const effects = [
      f.status,
      f.error,
      f.delayMs,
      f.redirect,
      f.truncateAfterBytes,
      f.stallMs,
    ].filter((v) => v !== undefined);
    if (effects.length === 0) ctx.addIssue({ code: "custom", message: "fault has no effect" });
    if (f.redirect !== undefined && f.status !== undefined && (f.status < 301 || f.status > 308)) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "redirect status must be 3xx" });
    }
    if (f.redirect === undefined && f.status !== undefined && f.status < 400) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "error status must be 4xx/5xx" });
    }
    if ((f.truncateAfterBytes !== undefined || f.stallMs !== undefined) && f.route !== "media") {
      ctx.addIssue({ code: "custom", path: ["route"], message: "body faults are media only" });
    }
  });
export type FakeFault = z.output<typeof faultSchema>;

const consentHookSchema = z.strictObject({
  /** `ask` (default): show the page; `allow`/`deny`: answer every consent at once. */
  decision: z.enum(["ask", "allow", "deny"]),
  account: z
    .string()
    .regex(/^[A-Za-z0-9._@-]{1,64}$/)
    .optional(),
  scopeMissing: z.boolean().optional(),
});
type ConsentHook = z.output<typeof consentHookSchema>;

export interface FakeGoogleServerOptions {
  /** Port to listen on; `0` (tests) picks a free one. Default 8099. */
  readonly port?: number;
  /** Interface; default `127.0.0.1` (the CLI passes `GOOGLE_FAKE_HOST`, default `0.0.0.0`). */
  readonly host?: string;
  /** Browser-facing base (consent, picker pages, `pickerUri`); default `http://<host>:<port>`. */
  readonly publicUrl?: string;
  /** Base the api/worker reach (`baseUrl`s); default `http://<host>:<port>`. */
  readonly internalUrl?: string;
  /** Directory with the HEIC fixture (`e2e/fixtures/heic`); H-1 is served only with it. */
  readonly fixturesDir?: string;
  /** Seed of token/code/session values; same seed ⇒ same sequence. Default fixed (tests). */
  readonly tokenSeed?: string;
  /** Defaults to `process.env.NODE_ENV`; `production` is refused. */
  readonly nodeEnv?: string | undefined;
  /** Clock (ms); tests may inject one. */
  readonly now?: () => number;
  readonly pollIntervalSec?: number;
  readonly sessionTtlSec?: number;
  readonly accessTokenTtlSec?: number;
  readonly codeTtlSec?: number;
  /** pino-compatible logger; default a silent one for the library, JSON for the CLI. */
  readonly logger?: FakeLogger;
}

export interface FakeLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface FakeRevocation {
  readonly token: string;
  readonly kind: "refresh" | "access";
  readonly account: string;
}

export interface FakeRecordedRequest {
  readonly method: string;
  readonly path: string;
}

export interface FakeSessionView {
  readonly id: string;
  readonly account: string;
  readonly mediaItemsSet: boolean;
  readonly picked: readonly string[];
  readonly deleted: boolean;
  readonly expired: boolean;
}

export interface FakeGoogleServer {
  /** Listening base (`http://127.0.0.1:<port>`). */
  readonly url: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly catalogue: readonly FakeCatalogueItem[];
  /** Requests seen (method + path, never query or headers), test hooks excluded. */
  requests(): FakeRecordedRequest[];
  revocations(): FakeRevocation[];
  sessions(): FakeSessionView[];
  addFault(fault: z.input<typeof faultSchema>): void;
  /** Revokes every grant (refresh ⇒ `invalid_grant`, Bearer ⇒ 401). */
  revokeAll(): number;
  /** Clears grants, codes, sessions, faults, recordings and the consent hook. */
  reset(): void;
  close(): Promise<void>;
}

interface Grant {
  readonly id: number;
  readonly account: string;
  readonly scope: string;
  readonly refreshToken: string;
  revoked: boolean;
}
interface AccessToken {
  readonly grantId: number;
  expiresAt: number;
}
interface AuthCode {
  readonly account: string;
  readonly scope: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
  used: boolean;
}
interface Session {
  readonly id: string;
  readonly account: string;
  readonly expiresAt: number;
  expiredByHook: boolean;
  mediaItemsSet: boolean;
  picked: string[];
  deleted: boolean;
}
interface StoredFault {
  readonly fault: FakeFault;
  remaining: number | "always";
}

interface State {
  grants: Map<number, Grant>;
  refreshIndex: Map<string, number>;
  accessTokens: Map<string, AccessToken>;
  codes: Map<string, AuthCode>;
  sessions: Map<string, Session>;
  faults: StoredFault[];
  requests: FakeRecordedRequest[];
  revocations: FakeRevocation[];
  consent: ConsentHook;
  counter: number;
}

function freshState(): State {
  return {
    grants: new Map(),
    refreshIndex: new Map(),
    accessTokens: new Map(),
    codes: new Map(),
    sessions: new Map(),
    faults: [],
    requests: [],
    revocations: [],
    consent: { decision: "ask" },
    counter: 0,
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const GOOGLE_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  412: "FAILED_PRECONDITION",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

function googleStatusName(status: number): string {
  return GOOGLE_STATUS[status] ?? (status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT");
}

function oauthErrorFor(status: number): string {
  if (status === 401) return "invalid_client";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "server_error";
  return "invalid_request";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

const silentLogger: FakeLogger = { info() {}, warn() {}, error() {} };

/** Starts the fake. Throws when `NODE_ENV=production` or the catalogue is not GPS-free. */
export async function startFakeGoogleServer(
  options: FakeGoogleServerOptions = {},
): Promise<FakeGoogleServer> {
  const nodeEnv = "nodeEnv" in options ? options.nodeEnv : process.env.NODE_ENV;
  if (nodeEnv?.trim() === "production") {
    throw new Error("the fake Google server is dev/test only: refusing NODE_ENV=production");
  }
  const log = options.logger ?? silentLogger;
  const now = options.now ?? Date.now;
  const tokenSeed = options.tokenSeed ?? "tinyglow-google-fake";
  const pollIntervalSec = options.pollIntervalSec ?? 3;
  const sessionTtlMs = (options.sessionTtlSec ?? 1800) * 1000;
  const accessTtlSec = options.accessTokenTtlSec ?? 3600;
  const codeTtlMs = (options.codeTtlSec ?? 600) * 1000;
  const host = options.host ?? "127.0.0.1";

  const catalogue = await buildFakeCatalogue({ fixturesDir: options.fixturesDir });
  const byId = new Map(catalogue.map((i) => [i.id, i]));

  let state = freshState();
  let publicUrl = "";
  let internalUrl = "";

  /** `fake-<kind>-<32 hex>`: deterministic per seed and sequence number. */
  function mint(kind: "access" | "refresh" | "code" | "session"): string {
    state.counter += 1;
    const h = createHash("sha256")
      .update(`${tokenSeed}:${kind}:${state.counter}`)
      .digest("hex")
      .slice(0, 32);
    return `fake-${kind}-${h}`;
  }

  function issueAccessToken(grantId: number): string {
    const token = mint("access");
    state.accessTokens.set(token, { grantId, expiresAt: now() + accessTtlSec * 1000 });
    return token;
  }

  function sessionExpired(s: Session): boolean {
    return s.expiredByHook || now() >= s.expiresAt;
  }

  function sessionJson(s: Session) {
    const remaining = Math.max(0, Math.floor((s.expiresAt - now()) / 1000));
    return {
      id: s.id,
      pickerUri: `${publicUrl}/picker/${s.id}`,
      pollingConfig: { pollInterval: `${pollIntervalSec}s`, timeoutIn: `${remaining}s` },
      expireTime: new Date(s.expiresAt).toISOString(),
      mediaItemsSet: s.mediaItemsSet,
    };
  }

  function itemJson(item: FakeCatalogueItem) {
    return {
      id: item.id,
      createTime: item.createTime,
      type: item.type,
      mediaFile: {
        baseUrl: `${internalUrl}/media/${item.id}`,
        mimeType: item.mimeType,
        filename: item.filename,
        mediaFileMetadata: {
          width: item.width,
          height: item.height,
          cameraMake: "Fake",
          cameraModel: "Picker",
        },
      },
    };
  }

  function catalogueJson(item: FakeCatalogueItem) {
    return {
      id: item.id,
      type: item.type,
      mimeType: item.mimeType,
      filename: item.filename,
      width: item.width,
      height: item.height,
      createTime: item.createTime,
      exifDateTimeOriginal: item.exifDateTimeOriginal,
      exifOffsetTimeOriginal: item.exifOffsetTimeOriginal,
      bytes: item.bytes.length,
      claimedLength: item.claimedLength,
      sha256: item.sha256,
    };
  }

  /** The grant behind a valid `Authorization: Bearer` header, else a 401. */
  function requireBearer(req: IncomingMessage): Grant {
    const header = req.headers.authorization;
    const m = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m?.[1]) throw new HttpError(401, "UNAUTHENTICATED", "missing bearer token");
    const at = state.accessTokens.get(m[1]);
    const grant = at ? state.grants.get(at.grantId) : undefined;
    if (!at || !grant || grant.revoked || now() >= at.expiresAt) {
      throw new HttpError(401, "UNAUTHENTICATED", "invalid or expired access token");
    }
    if (!scopeIncludesPicker(grant.scope)) {
      throw new HttpError(403, "PERMISSION_DENIED", "insufficient authentication scopes");
    }
    return grant;
  }

  function ownedSession(grant: Grant, id: string): Session {
    const s = state.sessions.get(id);
    if (!s || s.deleted || s.account !== grant.account || sessionExpired(s)) {
      throw new HttpError(404, "NOT_FOUND", "session not found");
    }
    return s;
  }

  // -------------------------------------------------------------------------------------------
  // Responses
  // -------------------------------------------------------------------------------------------

  function send(
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    headers: OutgoingHttpHeaders = {},
  ): void {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Length": buf.length,
      ...headers,
    });
    res.end(buf);
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
    send(res, status, JSON.stringify(body), {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    });
  }

  function sendHtml(res: ServerResponse, status: number, title: string, body: string): void {
    send(
      res,
      status,
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>` +
        `body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222}` +
        `button{font:inherit;padding:.6rem 1.2rem;margin:.25rem;border-radius:.5rem;border:1px solid #888;background:#fff}` +
        `button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}` +
        `li{list-style:none;margin:.3rem 0}code{font-size:.85em}` +
        `</style></head><body>${body}</body></html>`,
      { "Content-Type": "text/html; charset=utf-8" },
    );
  }

  function sendError(
    res: ServerResponse,
    route: FakeRoute | null,
    status: number,
    code: string | undefined,
    message: string,
    headers: OutgoingHttpHeaders = {},
  ): void {
    if (route === "token" || route === "revoke") {
      sendJson(
        res,
        status,
        {
          error: code && /^[a-z_]+$/.test(code) ? code : oauthErrorFor(status),
          error_description: message,
        },
        headers,
      );
      return;
    }
    if (route === "auth" || route === "picker") {
      sendHtml(
        res,
        status,
        `Error ${status}`,
        `<h1>Error ${status}</h1><p>${escapeHtml(message)}</p>`,
      );
      return;
    }
    const extra: OutgoingHttpHeaders =
      status === 401 ? { "WWW-Authenticate": 'Bearer error="invalid_token"', ...headers } : headers;
    sendJson(
      res,
      status,
      {
        error: {
          code: status,
          message,
          status: code && /^[A-Z_]+$/.test(code) ? code : googleStatusName(status),
        },
      },
      extra,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------------------------------------------

  async function readBody(req: IncomingMessage): Promise<Record<string, string | string[]>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const b = chunk as Buffer;
      size += b.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "INVALID_ARGUMENT", "body too large");
      chunks.push(b);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.trim() === "") return {};
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if (type.startsWith("application/json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "INVALID_ARGUMENT", "invalid JSON body");
      }
      if (parsed === null || typeof parsed !== "object") {
        throw new HttpError(400, "INVALID_ARGUMENT", "JSON body must be an object");
      }
      return parsed as Record<string, string | string[]>;
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(raw)) {
      const prev = out[k];
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return out;
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const b = chunk as Buffer;
      size += b.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "INVALID_ARGUMENT", "body too large");
      chunks.push(b);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.trim() === "") return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "INVALID_ARGUMENT", "invalid JSON body");
    }
  }

  function str(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;
  }

  function takeFault(
    route: FakeRoute,
    ctx: { itemId?: string; sessionId?: string; grantType?: string },
  ): FakeFault | null {
    const idx = state.faults.findIndex(
      ({ fault: f }) =>
        f.route === route &&
        (f.itemId === undefined || f.itemId === ctx.itemId) &&
        (f.sessionId === undefined || f.sessionId === ctx.sessionId) &&
        (f.grantType === undefined || f.grantType === ctx.grantType),
    );
    if (idx < 0) return null;
    const stored = state.faults[idx] as StoredFault;
    if (stored.remaining !== "always") {
      stored.remaining -= 1;
      if (stored.remaining <= 0) state.faults.splice(idx, 1);
    }
    return stored.fault;
  }

  /**
   * Applies a fault's delay and terminal effects. Returns `true` when it answered the request;
   * body faults (media) are left to the media handler.
   */
  async function applyFault(
    req: IncomingMessage,
    res: ServerResponse,
    route: FakeRoute,
    fault: FakeFault | null,
  ): Promise<boolean> {
    if (!fault) return false;
    await sleep(fault.delayMs ?? 0);
    if (fault.redirect) {
      const reqHost = String(req.headers.host ?? `${host}:${serverPort()}`);
      const target = new URL(req.url ?? "/", `http://${reqHost}`);
      if (fault.location) {
        send(res, fault.status ?? 302, "", { Location: fault.location });
        return true;
      }
      if (fault.redirect === "cross-host") {
        target.hostname = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
      }
      send(res, fault.status ?? 302, "", { Location: target.href });
      return true;
    }
    if (fault.status !== undefined || fault.error !== undefined) {
      const status = fault.status ?? 400;
      const headers: OutgoingHttpHeaders = {};
      if (fault.retryAfter !== undefined) headers["Retry-After"] = String(fault.retryAfter);
      else if (status === 429) headers["Retry-After"] = "1";
      sendError(res, route, status, fault.error, "injected fault", headers);
      return true;
    }
    return false;
  }

  function serverPort(): number {
    const addr = server.address();
    return addr && typeof addr === "object" ? (addr as AddressInfo).port : 0;
  }

  // -------------------------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------------------------

  interface ConsentParams {
    redirectUri: string;
    state: string | undefined;
    scope: string;
    account: string;
    scopeMissing: boolean;
  }

  function consentParams(p: (k: string) => string | undefined): ConsentParams {
    const redirectUri = p("redirect_uri");
    let target: URL | null = null;
    try {
      target = redirectUri ? new URL(redirectUri) : null;
    } catch {
      target = null;
    }
    if (!redirectUri || !target || (target.protocol !== "http:" && target.protocol !== "https:")) {
      throw new HttpError(400, "invalid_request", "redirect_uri must be an absolute http(s) URL");
    }
    const responseType = p("response_type");
    if (responseType !== undefined && responseType !== "code") {
      throw new HttpError(400, "unsupported_response_type", "response_type must be code");
    }
    const scope = (p("scope") ?? "").trim();
    if (scope === "") throw new HttpError(400, "invalid_scope", "scope is required");
    const account = p("account") ?? state.consent.account ?? FAKE_GOOGLE_DEFAULT_ACCOUNT;
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(account)) {
      throw new HttpError(400, "invalid_request", "account must be 1-64 of [A-Za-z0-9._@-]");
    }
    const sm = p("scope_missing");
    const scopeMissing =
      sm !== undefined ? sm === "1" || sm === "true" : !!state.consent.scopeMissing;
    return { redirectUri, state: p("state"), scope, account, scopeMissing };
  }

  function decide(res: ServerResponse, c: ConsentParams, allow: boolean): void {
    const target = new URL(c.redirectUri);
    if (!allow) {
      target.searchParams.set("error", "access_denied");
    } else {
      const requested = c.scope.split(/\s+/).filter((s) => s !== "");
      const granted = c.scopeMissing
        ? requested.filter((s) => s !== GOOGLE_PICKER_SCOPE)
        : requested;
      const code = mint("code");
      state.codes.set(code, {
        account: c.account,
        scope: granted.length > 0 ? granted.join(" ") : "openid",
        redirectUri: c.redirectUri,
        expiresAt: now() + codeTtlMs,
        used: false,
      });
      target.searchParams.set("code", code);
      target.searchParams.set("scope", granted.join(" "));
    }
    if (c.state !== undefined) target.searchParams.set("state", c.state);
    send(res, 302, "", { Location: target.href });
  }

  function consentPage(res: ServerResponse, c: ConsentParams): void {
    const hidden = (name: string, value: string | undefined) =>
      value === undefined
        ? ""
        : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    sendHtml(
      res,
      200,
      "Fake Google · Sign in",
      `<p><strong>Fake Google</strong></p>` +
        `<h1>Tinyglow wants to see photos you pick</h1>` +
        `<p>Signed in as <code>${escapeHtml(c.account)}</code>. This is a development stand-in for Google; no real account is involved.</p>` +
        `<form method="post" action="/o/oauth2/v2/auth/decide">` +
        hidden("redirect_uri", c.redirectUri) +
        hidden("state", c.state) +
        hidden("scope", c.scope) +
        hidden("account", c.account) +
        hidden("scope_missing", c.scopeMissing ? "1" : "0") +
        `<button type="submit" name="decision" value="deny" id="deny">Deny</button>` +
        `<button type="submit" name="decision" value="allow" id="allow" class="primary">Allow</button>` +
        `</form>`,
    );
  }

  async function handleToken(res: ServerResponse, body: Record<string, string | string[]>) {
    const grantType = str(body.grant_type);
    if (grantType === "authorization_code") {
      const code = str(body.code);
      const record = code ? state.codes.get(code) : undefined;
      if (!code || !record || record.used || now() >= record.expiresAt) {
        if (record) record.used = true;
        throw new HttpError(400, "invalid_grant", "Malformed auth code.");
      }
      record.used = true;
      if (str(body.redirect_uri) !== record.redirectUri) {
        throw new HttpError(400, "redirect_uri_mismatch", "Bad Request");
      }
      const id = state.grants.size + 1;
      const refreshToken = mint("refresh");
      state.grants.set(id, {
        id,
        account: record.account,
        scope: record.scope,
        refreshToken,
        revoked: false,
      });
      state.refreshIndex.set(refreshToken, id);
      sendJson(res, 200, {
        access_token: issueAccessToken(id),
        expires_in: accessTtlSec,
        refresh_token: refreshToken,
        scope: record.scope,
        token_type: "Bearer",
      });
      return;
    }
    if (grantType === "refresh_token") {
      const rt = str(body.refresh_token);
      const id = rt ? state.refreshIndex.get(rt) : undefined;
      const grant = id !== undefined ? state.grants.get(id) : undefined;
      if (!grant || grant.revoked) {
        throw new HttpError(400, "invalid_grant", "Token has been expired or revoked.");
      }
      sendJson(res, 200, {
        access_token: issueAccessToken(grant.id),
        expires_in: accessTtlSec,
        scope: grant.scope,
        token_type: "Bearer",
      });
      return;
    }
    if (grantType === undefined) throw new HttpError(400, "invalid_request", "Missing grant_type.");
    throw new HttpError(400, "unsupported_grant_type", "Invalid grant_type.");
  }

  function handleRevoke(res: ServerResponse, token: string | undefined): void {
    if (!token) throw new HttpError(400, "invalid_request", "Missing required parameter: token");
    const refreshGrant = state.refreshIndex.get(token);
    const access = state.accessTokens.get(token);
    const grantId = refreshGrant ?? access?.grantId;
    const grant = grantId !== undefined ? state.grants.get(grantId) : undefined;
    if (!grant || grant.revoked) {
      throw new HttpError(400, "invalid_token", "Token expired or revoked");
    }
    grant.revoked = true;
    state.revocations.push({
      token,
      kind: refreshGrant !== undefined ? "refresh" : "access",
      account: grant.account,
    });
    sendJson(res, 200, {});
  }

  // -------------------------------------------------------------------------------------------
  // Picker
  // -------------------------------------------------------------------------------------------

  function encodePageToken(sessionId: string, offset: number): string {
    return Buffer.from(`${sessionId}:${offset}`, "utf8").toString("base64url");
  }

  function decodePageToken(sessionId: string, token: string): number {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const m = /^(.+):(\d{1,6})$/.exec(raw);
    if (!m || m[1] !== sessionId)
      throw new HttpError(400, "INVALID_ARGUMENT", "invalid page token");
    return Number(m[2]);
  }

  function pick(s: Session, ids: readonly string[]): void {
    if (s.mediaItemsSet) throw new HttpError(409, "ABORTED", "items already picked");
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new HttpError(400, "INVALID_ARGUMENT", "pick at least one item");
    for (const id of unique) {
      if (!byId.has(id)) throw new HttpError(400, "INVALID_ARGUMENT", `unknown item ${id}`);
    }
    s.picked = unique;
    s.mediaItemsSet = true;
  }

  function pickerSession(id: string): Session {
    const s = state.sessions.get(id);
    if (!s || s.deleted)
      throw new HttpError(404, "NOT_FOUND", "This picking session does not exist.");
    if (sessionExpired(s)) throw new HttpError(410, "NOT_FOUND", "This picking session expired.");
    return s;
  }

  function pickerDone(res: ServerResponse, s: Session): void {
    sendHtml(
      res,
      200,
      "Fake Google Photos · Done",
      `<h1>Done</h1><p id="done">${s.picked.length} item(s) added. You can close this window and return to Tinyglow.</p>`,
    );
  }

  function pickerPage(res: ServerResponse, s: Session): void {
    if (s.mediaItemsSet) {
      pickerDone(res, s);
      return;
    }
    const rows = catalogue
      .map(
        (item) =>
          `<li><label><input type="checkbox" name="items" value="${escapeHtml(item.id)}"> ` +
          `<code>${escapeHtml(item.id)}</code> ${escapeHtml(item.type)} ${escapeHtml(item.mimeType)} · ` +
          `${escapeHtml(item.createTime.slice(0, 10))}</label></li>`,
      )
      .join("");
    sendHtml(
      res,
      200,
      "Fake Google Photos · Select",
      `<p><strong>Fake Google Photos</strong></p><h1>Select photos for Tinyglow</h1>` +
        `<form method="post" action="/picker/${escapeHtml(s.id)}"><ul>${rows}</ul>` +
        `<button type="submit" id="done" class="primary">Done</button></form>`,
    );
  }

  async function serveMedia(
    req: IncomingMessage,
    res: ServerResponse,
    item: FakeCatalogueItem,
    fault: FakeFault | null,
  ): Promise<void> {
    const total = item.claimedLength ?? item.bytes.length;
    let cut: number | null = item.claimedLength !== null ? item.bytes.length : null;
    if (fault?.truncateAfterBytes !== undefined) {
      cut = Math.min(cut ?? item.bytes.length, fault.truncateAfterBytes);
    }
    const body = cut !== null ? item.bytes.subarray(0, cut) : item.bytes;
    res.writeHead(200, {
      "Content-Type": item.mimeType,
      "Content-Length": total,
      "Cache-Control": "private, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stall = fault?.stallMs ?? 0;
    const first =
      stall > 0 ? body.subarray(0, Math.min(64 * 1024, Math.floor(body.length / 2))) : body;
    await new Promise<void>((resolve) => res.write(first, () => resolve()));
    if (stall > 0) {
      await sleep(stall);
      if (res.destroyed) return;
      await new Promise<void>((resolve) => res.write(body.subarray(first.length), () => resolve()));
    }
    if (body.length < total) {
      // Announced more than we send: drop the connection (the size guard aborts before this).
      res.destroy();
      return;
    }
    res.end();
  }

  // -------------------------------------------------------------------------------------------
  // Test hooks
  // -------------------------------------------------------------------------------------------

  function sessionViews(): FakeSessionView[] {
    return [...state.sessions.values()].map((s) => ({
      id: s.id,
      account: s.account,
      mediaItemsSet: s.mediaItemsSet,
      picked: [...s.picked],
      deleted: s.deleted,
      expired: sessionExpired(s),
    }));
  }

  function addFault(input: unknown): void {
    const parsed = faultSchema.parse(input);
    state.faults.push({ fault: parsed, remaining: parsed.times });
  }

  function revokeAll(): number {
    let n = 0;
    for (const g of state.grants.values()) {
      if (!g.revoked) {
        g.revoked = true;
        n += 1;
      }
    }
    return n;
  }

  async function handleHook(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    pathname: string,
  ): Promise<void> {
    if (method === "GET" && pathname === "/__fake/items") {
      sendJson(res, 200, catalogue.map(catalogueJson));
      return;
    }
    const itemMatch = /^\/__fake\/items\/([A-Za-z0-9-]{1,32})$/.exec(pathname);
    if (method === "GET" && itemMatch) {
      const item = byId.get(itemMatch[1] as string);
      if (!item) throw new HttpError(404, "NOT_FOUND", "unknown item");
      send(res, 200, item.bytes, { "Content-Type": item.mimeType });
      return;
    }
    if (method === "POST" && pathname === "/__fake/revoke-all") {
      sendJson(res, 200, { revoked: revokeAll() });
      return;
    }
    if (method === "GET" && pathname === "/__fake/revocations") {
      sendJson(res, 200, state.revocations);
      return;
    }
    if (pathname === "/__fake/requests") {
      if (method === "GET") {
        sendJson(res, 200, state.requests);
        return;
      }
      if (method === "DELETE") {
        state.requests = [];
        sendJson(res, 200, {});
        return;
      }
    }
    if (pathname === "/__fake/faults") {
      if (method === "GET") {
        sendJson(
          res,
          200,
          state.faults.map((f) => ({ ...f.fault, remaining: f.remaining })),
        );
        return;
      }
      if (method === "DELETE") {
        state.faults = [];
        sendJson(res, 200, {});
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const list = Array.isArray(body) ? body : [body];
        const parsed = list.map((f) => faultSchema.safeParse(f));
        const bad = parsed.find((p) => !p.success);
        if (bad && !bad.success) {
          sendJson(res, 400, {
            error: "invalid_fault",
            issues: bad.error.issues.map((i) => i.message),
          });
          return;
        }
        for (const p of parsed)
          if (p.success) state.faults.push({ fault: p.data, remaining: p.data.times });
        sendJson(res, 201, { faults: state.faults.length });
        return;
      }
    }
    if (method === "POST" && pathname === "/__fake/consent") {
      const parsed = consentHookSchema.safeParse(await readJsonBody(req));
      if (!parsed.success) {
        sendJson(res, 400, { error: "invalid_consent" });
        return;
      }
      state.consent = parsed.data;
      sendJson(res, 200, state.consent);
      return;
    }
    if (method === "GET" && pathname === "/__fake/sessions") {
      sendJson(res, 200, sessionViews());
      return;
    }
    const expireMatch = /^\/__fake\/sessions\/([A-Za-z0-9-]{1,128})\/expire$/.exec(pathname);
    if (method === "POST" && expireMatch) {
      const s = state.sessions.get(expireMatch[1] as string);
      if (!s) throw new HttpError(404, "NOT_FOUND", "unknown session");
      s.expiredByHook = true;
      sendJson(res, 200, {});
      return;
    }
    if (method === "POST" && pathname === "/__fake/expire-access-tokens") {
      for (const at of state.accessTokens.values()) at.expiresAt = 0;
      sendJson(res, 200, { expired: state.accessTokens.size });
      return;
    }
    if (method === "POST" && pathname === "/__fake/reset") {
      state = freshState();
      sendJson(res, 200, {});
      return;
    }
    throw new HttpError(404, "NOT_FOUND", "unknown test hook");
  }

  // -------------------------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------------------------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const pathname = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;

    if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (pathname.startsWith("/__fake/")) {
      await handleHook(req, res, method, pathname);
      return;
    }

    state.requests.push({ method, path: pathname });
    if (state.requests.length > MAX_RECORDED_REQUESTS) state.requests.shift();

    let route: FakeRoute | null = null;
    try {
      // OAuth consent
      if (pathname === "/o/oauth2/v2/auth" && method === "GET") {
        route = "auth";
        if (await applyFault(req, res, route, takeFault(route, {}))) return;
        const c = consentParams(q);
        const decision = q("fake_decision") ?? state.consent.decision;
        if (decision === "allow" || decision === "deny") {
          decide(res, c, decision === "allow");
          return;
        }
        consentPage(res, c);
        return;
      }
      if (pathname === "/o/oauth2/v2/auth/decide" && method === "POST") {
        route = "auth";
        const body = await readBody(req);
        const c = consentParams((k) => str(body[k]));
        decide(res, c, str(body.decision) === "allow");
        return;
      }
      if (pathname === "/token" && method === "POST") {
        route = "token";
        const body = await readBody(req);
        const grantType = str(body.grant_type);
        if (await applyFault(req, res, route, takeFault(route, grantType ? { grantType } : {}))) {
          return;
        }
        await handleToken(res, body);
        return;
      }
      if (pathname === "/revoke" && method === "POST") {
        route = "revoke";
        const body = await readBody(req);
        if (await applyFault(req, res, route, takeFault(route, {}))) return;
        handleRevoke(res, str(body.token) ?? q("token"));
        return;
      }
      if (pathname === "/v1/sessions" && method === "POST") {
        route = "sessions.create";
        await readBody(req); // `pickingConfig` is accepted and ignored
        if (await applyFault(req, res, route, takeFault(route, {}))) return;
        const grant = requireBearer(req);
        const id = mint("session");
        const s: Session = {
          id,
          account: grant.account,
          expiresAt: now() + sessionTtlMs,
          expiredByHook: false,
          mediaItemsSet: false,
          picked: [],
          deleted: false,
        };
        state.sessions.set(id, s);
        sendJson(res, 200, sessionJson(s));
        return;
      }
      const sessionMatch = /^\/v1\/sessions\/([A-Za-z0-9-]{1,128})$/.exec(pathname);
      if (sessionMatch && (method === "GET" || method === "DELETE")) {
        const sessionId = sessionMatch[1] as string;
        route = method === "GET" ? "sessions.get" : "sessions.delete";
        if (await applyFault(req, res, route, takeFault(route, { sessionId }))) return;
        const grant = requireBearer(req);
        const s = ownedSession(grant, sessionId);
        if (method === "GET") {
          sendJson(res, 200, sessionJson(s));
        } else {
          s.deleted = true;
          sendJson(res, 200, {});
        }
        return;
      }
      if (pathname === "/v1/mediaItems" && method === "GET") {
        route = "mediaItems";
        const sessionId = q("sessionId");
        if (await applyFault(req, res, route, takeFault(route, sessionId ? { sessionId } : {}))) {
          return;
        }
        const grant = requireBearer(req);
        if (!sessionId) throw new HttpError(400, "INVALID_ARGUMENT", "sessionId is required");
        const s = ownedSession(grant, sessionId);
        if (!s.mediaItemsSet) {
          throw new HttpError(400, "FAILED_PRECONDITION", "the user has not picked items yet");
        }
        const sizeRaw = q("pageSize");
        let pageSize = PAGE_SIZE_DEFAULT;
        if (sizeRaw !== undefined) {
          if (!/^\d{1,6}$/.test(sizeRaw) || Number(sizeRaw) < 1) {
            throw new HttpError(400, "INVALID_ARGUMENT", "invalid pageSize");
          }
          pageSize = Math.min(PAGE_SIZE_MAX, Number(sizeRaw));
        }
        const tokenRaw = q("pageToken");
        const offset = tokenRaw ? decodePageToken(s.id, tokenRaw) : 0;
        const ids = s.picked.slice(offset, offset + pageSize);
        const next = offset + ids.length;
        sendJson(res, 200, {
          mediaItems: ids.map((id) => itemJson(byId.get(id) as FakeCatalogueItem)),
          ...(next < s.picked.length ? { nextPageToken: encodePageToken(s.id, next) } : {}),
        });
        return;
      }
      const pickerMatch = /^\/picker\/([A-Za-z0-9-]{1,128})$/.exec(pathname);
      if (pickerMatch && (method === "GET" || method === "POST")) {
        route = "picker";
        const sessionId = pickerMatch[1] as string;
        const body = method === "POST" ? await readBody(req) : {};
        if (await applyFault(req, res, route, takeFault(route, { sessionId }))) return;
        const s = pickerSession(sessionId);
        if (method === "POST") {
          const items = body.items;
          pick(s, Array.isArray(items) ? items : typeof items === "string" ? [items] : []);
          pickerDone(res, s);
          return;
        }
        const auto = q("autopick");
        if (auto !== undefined && !s.mediaItemsSet) {
          pick(
            s,
            auto === "all"
              ? catalogue.map((i) => i.id)
              : auto
                  .split(",")
                  .map((x) => x.trim())
                  .filter((x) => x !== ""),
          );
        }
        pickerPage(res, s);
        return;
      }
      const mediaMatch = /^\/media\/([A-Za-z0-9-]{1,32})(=[A-Za-z0-9-]*)?$/.exec(pathname);
      if (mediaMatch && (method === "GET" || method === "HEAD")) {
        route = "media";
        const itemId = mediaMatch[1] as string;
        const fault = takeFault(route, { itemId });
        if (await applyFault(req, res, route, fault)) return;
        requireBearer(req);
        if (mediaMatch[2] !== "=d") {
          throw new HttpError(400, "INVALID_ARGUMENT", "the fake serves only the =d download");
        }
        const item = byId.get(itemId);
        if (!item) throw new HttpError(404, "NOT_FOUND", "media item not found");
        await serveMedia(req, res, item, fault);
        return;
      }
      throw new HttpError(404, "NOT_FOUND", "not found");
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, route, err.status, err.code, err.message);
        return;
      }
      log.error({ route, category: "internal" }, "fake Google handler failed");
      sendError(res, route, 500, undefined, "internal error");
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, null, 500, undefined, "internal error");
      else res.destroy();
    });
  });
  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? FAKE_GOOGLE_DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = serverPort();
  const displayHost =
    host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${displayHost}:${port}`;
  publicUrl = stripSlash(options.publicUrl ?? url);
  internalUrl = stripSlash(options.internalUrl ?? url);

  return {
    url,
    port,
    publicUrl,
    internalUrl,
    catalogue,
    requests: () => [...state.requests],
    revocations: () => [...state.revocations],
    sessions: sessionViews,
    addFault: (fault) => addFault(fault),
    revokeAll,
    reset: () => {
      state = freshState();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI: `pnpm --filter @tinyglow/worker google-fake` (dev: tsx; image: dist/import/google/fake-server.js)
// Env: GOOGLE_FAKE_PORT (8099), GOOGLE_FAKE_HOST (0.0.0.0), GOOGLE_FAKE_PUBLIC_URL,
// GOOGLE_FAKE_INTERNAL_URL (default http://localhost:<port>), FAKE_GOOGLE_FIXTURES_DIR (optional),
// GOOGLE_FAKE_TOKEN_SEED (optional; random per process otherwise), LOG_LEVEL.
// ---------------------------------------------------------------------------------------------

const cliEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  GOOGLE_FAKE_PORT: z.coerce.number().int().min(1).max(65535).default(FAKE_GOOGLE_DEFAULT_PORT),
  GOOGLE_FAKE_HOST: z.string().min(1).default("0.0.0.0"),
  GOOGLE_FAKE_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  GOOGLE_FAKE_INTERNAL_URL: z.url({ protocol: /^https?$/ }).optional(),
  FAKE_GOOGLE_FIXTURES_DIR: z.string().min(1).optional(),
  GOOGLE_FAKE_TOKEN_SEED: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

function emptyToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === "" ? undefined : v;
  return out;
}

async function main(): Promise<number> {
  if (process.env.NODE_ENV?.trim() === "production") {
    process.stderr.write(
      "google-fake: dev/test only, refusing to start with NODE_ENV=production\n",
    );
    return 1;
  }
  const parsed = cliEnvSchema.safeParse(emptyToUndefined(process.env));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    process.stderr.write(`google-fake: invalid env: ${fields}\n`);
    return 1;
  }
  const env = parsed.data;
  const logger = pino({
    name: "google-fake",
    level: env.LOG_LEVEL,
    redact: {
      paths: ["*.token", "*.access_token", "*.refresh_token", "*.code", "*.url", "*.authorization"],
      censor: "[redacted]",
    },
  });
  const base = `http://localhost:${env.GOOGLE_FAKE_PORT}`;
  let fake: FakeGoogleServer;
  try {
    fake = await startFakeGoogleServer({
      port: env.GOOGLE_FAKE_PORT,
      host: env.GOOGLE_FAKE_HOST,
      publicUrl: env.GOOGLE_FAKE_PUBLIC_URL ?? base,
      internalUrl: env.GOOGLE_FAKE_INTERNAL_URL ?? base,
      fixturesDir: env.FAKE_GOOGLE_FIXTURES_DIR,
      tokenSeed: env.GOOGLE_FAKE_TOKEN_SEED ?? randomBytes(16).toString("hex"),
      nodeEnv: env.NODE_ENV,
      logger,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    logger.error(
      {
        category: code === "EADDRINUSE" ? "port_in_use" : "start_failed",
        // Start-up errors (bind, catalogue checks) carry no token: nothing has been minted yet.
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "google-fake failed to start",
    );
    return 1;
  }
  logger.info(
    {
      port: fake.port,
      items: fake.catalogue.length,
      heic: fake.catalogue.some((i) => i.id === "H-1"),
    },
    "google-fake listening",
  );
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await fake.close().catch(() => undefined);
  logger.info({}, "google-fake stopped");
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
