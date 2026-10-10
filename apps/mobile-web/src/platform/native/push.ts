import type { PushNotificationsPlugin } from "@capacitor/push-notifications";
import {
  type PushData,
  type PushDeviceRegisterRequest,
  pushDataSchema,
  pushDeviceResponseSchema,
} from "@tinyglow/shared";
import { apiFetch } from "../../lib/api";
import { nativePlatform } from "../platform";

// Push client (docs/plans/step-9.md 2.8). Opt-in only: nothing is requested at launch; 9.9's
// Settings -> Notifications and the post-first-upload primer call `enablePush()`. Device tokens
// are sent once to `POST /me/push-devices` and never logged or stored. Notification payloads are
// validated against `pushDataSchema` (ids only) before they are used.

export type PushPermission = "granted" | "denied" | "prompt" | "unavailable";
export type EnablePushResult =
  | "enabled"
  | "denied"
  | "unavailable" // web, Android build without FCM, or plugin missing
  | "failed"; // permission granted but registration (or the API) failed

/** Android registration needs `google-services.json`; builds without it set VITE_PUSH_ANDROID != 1. */
export function pushSupported(): boolean {
  const p = nativePlatform();
  if (p === "ios") return true;
  if (p === "android") return import.meta.env.VITE_PUSH_ANDROID === "1";
  return false;
}

// Never return the plugin itself from an async function (or resolve any promise with it): a
// Capacitor plugin is a Proxy that answers every property, `then` included, so promise resolution
// treats it as a thenable, calls the non-existent native `PushNotifications.then()`, and the
// promise never settles. That hung Settings -> Notifications on iOS. Resolve with a wrapper.
async function plugin(): Promise<{ PN: PushNotificationsPlugin }> {
  return { PN: (await import("@capacitor/push-notifications")).PushNotifications };
}

/** A native permission check must never hang the UI: after `ms`, settle with `fallback`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const CHECK_TIMEOUT_MS = 5_000;

function toPermission(state: string): PushPermission {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  return "prompt";
}

export async function pushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return "unavailable";
  try {
    const { PN } = await plugin();
    const state = await withTimeout(
      PN.checkPermissions().then((r) => r.receive as string),
      CHECK_TIMEOUT_MS,
      "unavailable",
    );
    return state === "unavailable" ? "unavailable" : toPermission(state);
  } catch {
    return "unavailable";
  }
}

function appVersion(): string {
  const v = import.meta.env.VITE_APP_VERSION as string | undefined;
  return v && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : "1.0.0";
}

async function registerWithApi(token: string): Promise<boolean> {
  const platform = nativePlatform();
  if (!platform) return false;
  const body: PushDeviceRegisterRequest =
    platform === "ios"
      ? { platform, provider: "apns", token, appVersion: appVersion() }
      : { platform, provider: "fcm", token, appVersion: appVersion() };
  try {
    await apiFetch("/me/push-devices", { method: "POST", body, schema: pushDeviceResponseSchema });
    return true;
  } catch {
    // 404 before 9.7 lands, 429, offline: notifications simply stay off.
    return false;
  }
}

let listenersReady = false;
let pendingToken: ((token: string | null) => void) | null = null;

async function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;
  const { PN } = await plugin();
  await PN.addListener("registration", (t) => pendingToken?.(t.value));
  await PN.addListener("registrationError", () => pendingToken?.(null));
  await PN.addListener("pushNotificationActionPerformed", (action) => {
    const parsed = pushDataSchema.safeParse(
      action.notification.data?.ll ?? action.notification.data,
    );
    if (parsed.success) for (const cb of tapListeners) cb(parsed.data);
  });
  if (nativePlatform() === "android") {
    await PN.createChannel({ id: "default", name: "Tinyglow", importance: 3 }).catch(
      () => undefined,
    );
  }
}

/**
 * Asks the OS for permission (first call shows the system prompt), registers with APNs/FCM and
 * with the API. Safe to call again to refresh the token (e.g. after sign-in on a shared phone).
 */
export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported()) return "unavailable";
  try {
    const { PN } = await plugin();
    await ensureListeners();
    let perm: string = await withTimeout(
      PN.checkPermissions().then((r) => r.receive as string),
      CHECK_TIMEOUT_MS,
      "unavailable",
    );
    if (perm === "unavailable") return "failed";
    if (perm !== "granted") perm = (await PN.requestPermissions()).receive;
    if (perm !== "granted") return "denied";
    const token = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      pendingToken = (t) => {
        clearTimeout(timer);
        pendingToken = null;
        resolve(t);
      };
      void PN.register().catch(() => resolve(null));
    });
    if (!token) return "failed";
    return (await registerWithApi(token)) ? "enabled" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * On launch after sign-in: if the user already granted permission, refresh the token with the
 * API silently (tokens rotate). Never prompts.
 */
export async function refreshPushRegistration(): Promise<void> {
  if ((await pushPermission()) === "granted") await enablePush();
}

/** Sign-out: removes this session's device server-side (best effort) and stops local delivery. */
export async function unregisterCurrentPushDevice(): Promise<void> {
  try {
    await apiFetch("/me/push-devices/current", { method: "DELETE" });
  } catch {
    // offline, 404 before 9.7, or already signed out: the server also drops devices whose
    // session no longer exists.
  }
}

const tapListeners = new Set<(data: PushData) => void>();

/** Notification taps: `photos_analyzed` => select baby, open Chat; `share_viewed` => Family. */
export function onPushTap(cb: (data: PushData) => void): () => void {
  tapListeners.add(cb);
  if (pushSupported()) void ensureListeners().catch(() => undefined);
  return () => tapListeners.delete(cb);
}
