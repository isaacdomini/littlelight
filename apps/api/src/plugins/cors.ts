import { CLIENT_HEADER } from "@littlelight/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../lib/errors";
import { clientKindHeader } from "../lib/request";

// CORS for the native apps only (docs/plans/step-9.md 2.3). The web SPA is same-origin and
// never needs CORS; the bundled apps run in a WebView whose origin is `capacitor://localhost`
// (iOS) or `https://localhost` (Android), so their `fetch` to `VITE_API_URL` is cross-origin.
//
// - Only an `Origin` in `NATIVE_APP_ORIGINS` (exact, lowercase match) gets CORS headers. Unknown
//   origins get none (the browser blocks them; server behaviour is unchanged).
// - Never `Access-Control-Allow-Credentials`: native clients authenticate with bearer tokens, so
//   no cookie ever crosses origins (and `ll_access` is never honoured cross-origin by a browser).
// - Headers go out through `reply.raw.setHeader` in an `onRequest` hook: Node merges them into
//   whatever `writeHead` sends later, so every response carries them, including the chat SSE
//   stream and error responses, without any change to the route modules.
// - A preflight (`OPTIONS` + `Access-Control-Request-Method`) from an allowed origin is answered
//   here with 204 and never reaches auth or a route.
// - An actual request from an allowed origin must declare `X-Littlelight-Client: native`, else
//   403 `csrf_rejected` (same code as the step-3 cookie CSRF guard). The CORS headers are set
//   first so the app can read that error.
//
// Nothing here logs the origin or any header value.

export const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE";
export const CORS_ALLOW_HEADERS = `authorization, content-type, accept, ${CLIENT_HEADER}`;
export const CORS_MAX_AGE_SEC = 600;
export const CORS_EXPOSE_HEADERS = "Retry-After";

/** 403 for a native-origin request without `X-Littlelight-Client: native`. */
export const nativeHeaderRejected = () =>
  new ApiError(403, "csrf_rejected", "Missing client header on a cross-origin request");

function originOf(request: FastifyRequest): string | undefined {
  const v = request.headers.origin;
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim().toLowerCase() || undefined;
}

function appendVaryOrigin(reply: FastifyReply): void {
  const current = reply.raw.getHeader("vary");
  const list = (Array.isArray(current) ? current.join(",") : String(current ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (!list.some((s) => s.toLowerCase() === "origin" || s === "*")) list.push("Origin");
  reply.raw.setHeader("vary", list.join(", "));
}

/**
 * Install the native CORS hook. `allowedOrigins` is `NATIVE_APP_ORIGINS` as parsed by
 * `nativeCorsEnvSchema` (lowercase, de-duplicated). Register before auth so a preflight is
 * answered before any credential handling.
 */
export function registerNativeCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed: ReadonlySet<string> = new Set(allowedOrigins.map((o) => o.toLowerCase()));

  app.addHook("onRequest", async (request, reply) => {
    const origin = originOf(request);
    if (origin === undefined || !allowed.has(origin)) return;

    reply.raw.setHeader("access-control-allow-origin", origin);
    appendVaryOrigin(reply);

    const isPreflight =
      request.method === "OPTIONS" &&
      request.headers["access-control-request-method"] !== undefined;
    if (isPreflight) {
      reply.raw.setHeader("access-control-allow-methods", CORS_ALLOW_METHODS);
      reply.raw.setHeader("access-control-allow-headers", CORS_ALLOW_HEADERS);
      reply.raw.setHeader("access-control-max-age", String(CORS_MAX_AGE_SEC));
      return reply.code(204).send();
    }

    reply.raw.setHeader("access-control-expose-headers", CORS_EXPOSE_HEADERS);
    if (clientKindHeader(request) !== "native") throw nativeHeaderRejected();
  });
}
