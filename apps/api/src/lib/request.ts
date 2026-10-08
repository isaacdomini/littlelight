import { isIP } from "node:net";
import {
  CLIENT_HEADER,
  type ClientKind,
  clientKindSchema,
  userAgentLabel,
} from "@littlelight/shared";
import type { FastifyRequest } from "fastify";

// Per-request client facts (docs/plans/step-3.md 2.2, 2.3). Hops: Cloudflare → cloudflared →
// nginx (prod) or Vite (dev) → api; port 3000 is never public, so `trustProxy: true` is safe.
// IPs feed rate limits and GoTrue only: never write them to logs, audit metadata or responses.

type Req = Pick<FastifyRequest, "headers" | "ip">;

function header(request: Req, name: string): string | undefined {
  const v = request.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : undefined;
}

/**
 * Client IP: `CF-Connecting-IP` when present and a valid IP literal, else Fastify's `request.ip`
 * (X-Forwarded-For aware with `trustProxy: true`).
 */
export function clientIp(request: Req): string {
  const cf = header(request, "cf-connecting-ip");
  if (cf && isIP(cf) !== 0) return cf;
  return request.ip;
}

const COUNTRY = /^[A-Z0-9]{2}$/;

/**
 * `CF-IPCountry` (ISO 3166-1 alpha-2, or Cloudflare's `XX`/`T1`), uppercased; `null` when absent
 * or malformed (dev has no Cloudflare). Shape matches `auditMetadataSchema.ip_country`.
 */
export function clientCountry(request: Req): string | null {
  const v = header(request, "cf-ipcountry")?.toUpperCase();
  return v && COUNTRY.test(v) ? v : null;
}

/**
 * The `X-Littlelight-Client` header parsed as a `ClientKind`, or `null` when absent/unknown.
 * Use this for the CSRF check (cookie transport + non-GET requires exactly `web`).
 */
export function clientKindHeader(request: Req): ClientKind | null {
  const parsed = clientKindSchema.safeParse(header(request, CLIENT_HEADER)?.toLowerCase());
  return parsed.success ? parsed.data : null;
}

/** Client kind for response shaping: `native` only when explicitly declared, else `web`. */
export function clientKind(request: Req): ClientKind {
  return clientKindHeader(request) ?? "web";
}

const MAX_UA = 512;

/** Raw User-Agent (truncated), for forwarding to GoTrue only. Never log or store it. */
export function clientUserAgent(request: Req): string | null {
  return header(request, "user-agent")?.slice(0, MAX_UA) ?? null;
}

/** Coarse device label ("Safari on iPhone") safe for audit metadata and emails. */
export function clientDeviceLabel(request: Req): string {
  return userAgentLabel(clientUserAgent(request));
}

/**
 * Headers the API forwards on its calls to GoTrue so `auth.sessions.ip/user_agent` and GoTrue's
 * own rate limits (`GOTRUE_RATE_LIMIT_HEADER`) see the real client.
 */
export function upstreamClientHeaders(request: Req): Record<string, string> {
  const ip = clientIp(request);
  const ua = clientUserAgent(request);
  return {
    "x-forwarded-for": ip,
    "cf-connecting-ip": ip,
    ...(ua ? { "user-agent": ua } : {}),
  };
}
