import type { ClientKind } from "@littlelight/shared";

// Step-9 seam: the Capacitor build returns true here (Capacitor.isNativePlatform()) so the API
// client sends `X-Littlelight-Client: native` and uses bearer tokens from `tokenStore`.
export function isNative(): boolean {
  return false;
}

export function clientKind(): ClientKind {
  return isNative() ? "native" : "web";
}
