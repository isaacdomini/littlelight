import { BlockList, isIP } from "node:net";
import {
  CLIENT_HEADER,
  type ClientKind,
  clientKindSchema,
  userAgentLabel,
} from "@littlelight/shared";
import type { FastifyRequest } from "fastify";

// Per-request client facts (docs/plans/step-3.md 2.2, 2.3). Hops: Cloudflare → cloudflared →
// nginx (prod) or Vite (dev) → api; port 3000 is never public. Fastify trusts exactly that last
// hop (`trustProxyHop`, docs/plans/review-fixes.md D10), so a client's own X-Forwarded-For
// entries cannot choose `request.ip`.
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
 * (the right-most X-Forwarded-For entry, i.e. the peer the proxy saw: `trustProxyHop`).
 * `CF-Connecting-IP` is set by Cloudflare, or by nginx from `$remote_addr` when absent; without
 * Cloudflare in front a client can still forge it (documented in `.env.example`).
 */
export function clientIp(request: Req): string {
  const cf = header(request, "cf-connecting-ip");
  if (cf && isIP(cf) !== 0) return cf;
  return request.ip;
}

/** Loopback and private ranges: where the proxy in front of the api (nginx / Vite) connects from. */
const PROXY_PEERS = new BlockList();
PROXY_PEERS.addSubnet("127.0.0.0", 8, "ipv4");
PROXY_PEERS.addSubnet("10.0.0.0", 8, "ipv4");
PROXY_PEERS.addSubnet("172.16.0.0", 12, "ipv4");
PROXY_PEERS.addSubnet("192.168.0.0", 16, "ipv4");
PROXY_PEERS.addAddress("::1", "ipv6");
PROXY_PEERS.addSubnet("fc00::", 7, "ipv6");

/** True for a loopback or private (RFC 1918 / ULA) address, IPv4-mapped IPv6 included. */
export function isProxyPeerAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const family = isIP(v4);
  if (family === 4) return PROXY_PEERS.check(v4, "ipv4");
  if (family === 6) return PROXY_PEERS.check(v4, "ipv6");
  return false;
}

/**
 * Fastify `trustProxy` (docs/plans/review-fixes.md 2.11, D10: "trust exactly one hop"). Only the
 * immediate TCP peer (hop 0) is trusted, and only when it is a loopback/private address (the
 * nginx or Vite container); `request.ip` is then the right-most X-Forwarded-For entry, which
 * nginx appends from `$remote_addr`. Entries a client prepends are never reached. A numeric
 * `trustProxy: 1` is not used: Fastify 5.12 treats any number as "trust nothing" (and its types
 * reject it), which would make `request.ip` the proxy's own address for every client.
 */
export function trustProxyHop(address: string, hop: number): boolean {
  return hop === 0 && isProxyPeerAddress(address);
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
