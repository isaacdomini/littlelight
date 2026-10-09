import { z } from "zod";
import {
  PUSH_PROVIDER_FOR_PLATFORM,
  PUSH_TOKEN_MAX_CHARS,
  PUSH_TOKEN_MIN_CHARS,
  pushPlatformSchema,
  pushProviderSchema,
} from "../push";
import { isoDateTimeSchema } from "./common";

// Push device contracts (docs/plans/step-9.md 2.8, 2.10). `POST /me/push-devices` needs
// `X-Littlelight-Client: native` (else 400 `validation_failed`), auth and consent; it runs
// `register_push_device(...)` under the caller's claims, bound to the caller's GoTrue session.
// `DELETE /me/push-devices/current` → 204 removes this session's device. The token is
// pino-redacted (`req.body.token`) and never logged, returned or echoed in an error.

/** `push_devices.app_version` CHECK: `^[0-9A-Za-z.+-]{1,32}$` (e.g. `1.0.0`, `1.0.0+12`). */
export const appVersionSchema = z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/);

/**
 * `POST /me/push-devices` body. Strict (unknown keys ⇒ 400). `token` is the APNs device token
 * (iOS) or FCM registration token (Android): 8..4096 chars, no whitespace. The platform and
 * provider must pair: `ios` ⇔ `apns`, `android` ⇔ `fcm`.
 */
export const pushDeviceRegisterRequestSchema = z
  .strictObject({
    platform: pushPlatformSchema,
    provider: pushProviderSchema,
    token: z.string().min(PUSH_TOKEN_MIN_CHARS).max(PUSH_TOKEN_MAX_CHARS).regex(/^\S+$/),
    appVersion: appVersionSchema,
  })
  .refine((b) => PUSH_PROVIDER_FOR_PLATFORM[b.platform] === b.provider, {
    path: ["provider"],
    message: "must be apns for ios and fcm for android",
  });
export type PushDeviceRegisterRequest = z.infer<typeof pushDeviceRegisterRequestSchema>;

/** `POST /me/push-devices` → 201. Never includes the token. */
export const pushDeviceResponseSchema = z.object({
  device: z.object({
    id: z.uuid(),
    platform: pushPlatformSchema,
    createdAt: isoDateTimeSchema,
  }),
});
export type PushDeviceResponse = z.infer<typeof pushDeviceResponseSchema>;
