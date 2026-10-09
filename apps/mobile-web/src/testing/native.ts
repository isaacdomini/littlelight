import { vi } from "vitest";
import type { StoredTokens, TokenStore } from "../platform/tokenStore";

// Test helpers for the native (Capacitor) code paths. Test-only.

export function setNativePlatform(platform: "ios" | "android" | null): void {
  (globalThis as { Capacitor?: unknown }).Capacitor = platform
    ? {
        isNativePlatform: () => true,
        getPlatform: () => platform,
        convertFileSrc: (p: string) => `capacitor://localhost/_capacitor_file_${p}`,
      }
    : undefined;
}

export interface MemoryTokenStore extends TokenStore {
  value: StoredTokens | null;
  clears: number;
}

export function memoryTokenStore(initial: StoredTokens | null = null): MemoryTokenStore {
  const s: MemoryTokenStore = {
    value: initial,
    clears: 0,
    get: async () => s.value,
    set: async (t) => {
      s.value = { ...t };
    },
    clear: async () => {
      s.value = null;
      s.clears += 1;
    },
  };
  return s;
}

/** A JWT-shaped string whose payload carries `exp` (seconds from now). Unsigned: tests only. */
export function fakeJwt(expInSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials | undefined;
  referrerPolicy: string | undefined;
}

/** Stub global fetch with a scripted responder; returns the recorded calls. */
export function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else {
      body = init?.body;
    }
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
      credentials: init?.credentials,
      referrerPolicy: init?.referrerPolicy,
    };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export const APP_ERROR = (error: string, message = "msg") => ({ error, message });
