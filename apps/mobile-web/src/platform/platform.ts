import type { ClientKind } from "@littlelight/shared";

// Minimal capability probe. Capacitor injects `window.Capacitor` into the native WebView before
// any script runs, so this needs no import: the web bundle carries no Capacitor code at all.
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  convertFileSrc?: (path: string) => string;
}
function cap(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True inside the Capacitor iOS/Android shell; false on the web (incl. installed PWA). */
export function isNative(): boolean {
  try {
    return cap()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

export type NativePlatform = "ios" | "android";

/** `"ios"` / `"android"` in the app, `null` on the web. */
export function nativePlatform(): NativePlatform | null {
  if (!isNative()) return null;
  const p = cap()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : null;
}

/** Maps a local file path to a WebView-loadable URL (`capacitor://localhost/_capacitor_file_/…`). */
export function convertFileSrc(path: string): string {
  const fn = cap()?.convertFileSrc;
  if (!fn) throw new Error("convertFileSrc unavailable");
  return fn(path);
}

export function clientKind(): ClientKind {
  return isNative() ? "native" : "web";
}
