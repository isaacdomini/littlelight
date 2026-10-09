import { z } from "zod";
import { APP_NAME } from "./constants";

// Push notification contracts (docs/plans/step-9.md 2.8, 2.9, 2.10; PRD "Capacitor plugins":
// "23 photos analyzed", "Grandma viewed the album"). Browser-safe: no Node imports.
//
// Privacy (D10): everything sent to Apple/Google is generic. The visible text comes only from
// `pushMessage(kind, count)`, which cannot take a name, caption or any parent text; the data
// payload carries opaque ids only. Device tokens are never logged.
//
// The enum values below match the `push_devices` / `push_deliveries` CHECK constraints of
// migration `1792200000100_native-push.sql` literally and in order: change both together.

/** `push_devices.platform`. */
export const pushPlatformSchema = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

/** `push_devices.provider`: APNs for iOS, FCM for Android (`(platform='ios') = (provider='apns')`). */
export const pushProviderSchema = z.enum(["apns", "fcm"]);
export type PushProvider = z.infer<typeof pushProviderSchema>;

/** The provider each platform must register with. */
export const PUSH_PROVIDER_FOR_PLATFORM = {
  ios: "apns",
  android: "fcm",
} as const satisfies Readonly<Record<PushPlatform, PushProvider>>;

/** `push_deliveries.kind`. Admins only; contributors and viewers never get push. */
export const pushKindSchema = z.enum(["photos_analyzed", "share_viewed"]);
export type PushKind = z.infer<typeof pushKindSchema>;

/**
 * `push_deliveries.status`, also the worker's `PushSendStatus`: `sent` (provider accepted),
 * `fake` (dev sender), `failed`, `invalid_token` (device disabled), `unconfigured` (no provider).
 */
export const pushDeliveryStatusSchema = z.enum([
  "sent",
  "fake",
  "failed",
  "invalid_token",
  "unconfigured",
]);
export type PushDeliveryStatus = z.infer<typeof pushDeliveryStatusSchema>;

/**
 * Data payload delivered with a notification (APNs `ll` key; FCM `data`, all strings) and read
 * by the app on tap: `photos_analyzed` ⇒ select `babyId`, open Chat; `share_viewed` ⇒ select
 * `babyId`, open Family. Ids only. Strict: an unexpected key fails instead of reaching a provider.
 */
export const pushDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("photos_analyzed"),
    babyId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("share_viewed"),
    babyId: z.uuid(),
    shareLinkId: z.uuid(),
  }),
]);
export type PushData = z.infer<typeof pushDataSchema>;

/** Device token length bound (`push_devices.token` CHECK `length(token) BETWEEN 8 AND 4096`). */
export const PUSH_TOKEN_MIN_CHARS = 8;
export const PUSH_TOKEN_MAX_CHARS = 4096;
/** `POST /me/push-devices` per user per hour (in-memory throttle ⇒ 429). */
export const PUSH_REGISTRATIONS_PER_HOUR = 20;
/** `push.notify` `startAfter` for `photos_analyzed` (coalesces a batch's reindex burst). */
export const PUSH_PHOTOS_DEBOUNCE_SEC_DEFAULT = 600;
/** `push.notify` `startAfter` for `share_viewed`. */
export const PUSH_SHARE_DEBOUNCE_SEC_DEFAULT = 60;
/** At most one push per user per (baby, kind) within this many minutes. */
export const PUSH_MIN_GAP_MIN_DEFAULT = 60;

/** Visible notification text. */
export interface PushText {
  title: string;
  body: string;
}

/**
 * The exact, generic text of a notification (2.8, D10). Takes only the kind and, for
 * `photos_analyzed`, the number of newly analysed photos (integer ≥ 1); `count` is ignored for
 * `share_viewed`. Nothing else can reach the lock screen.
 *
 * - `photos_analyzed`: "1 new photo is ready to search." / "{n} new photos are ready to search."
 * - `share_viewed`: "Someone opened your shared album."
 */
export function pushMessage(kind: PushKind, count = 1): PushText {
  switch (kind) {
    case "photos_analyzed": {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new RangeError("count must be a positive integer");
      }
      const body =
        count === 1
          ? "1 new photo is ready to search."
          : `${count.toLocaleString("en-US")} new photos are ready to search.`;
      return { title: APP_NAME, body };
    }
    case "share_viewed":
      return { title: APP_NAME, body: "Someone opened your shared album." };
  }
}
