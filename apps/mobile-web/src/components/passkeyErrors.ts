import { PASSKEY_MAX_PER_USER, passkeyLimitDetailsSchema } from "@tinyglow/shared";
import { t } from "../i18n";
import { errorMessage, isApiError } from "../lib/api";
import { isPasskeyError } from "../platform/passkeys";

/** Add / rename / remove failures -> one safe line (docs/plans/step-13.md 2.4 error codes). */
export function passkeyAddError(e: unknown): string {
  if (isPasskeyError(e, "cancelled")) return t("passkey.settings.cancelled");
  if (isPasskeyError(e, "not_configured")) return t("passkey.settings.notConfigured");
  if (isPasskeyError(e, "not_available") || isPasskeyError(e, "unsupported")) {
    return t("passkey.unavailable");
  }
  if (isPasskeyError(e)) return t("passkey.settings.failed");
  if (isApiError(e, "passkey_limit")) {
    const d = passkeyLimitDetailsSchema.safeParse(e.details);
    return t("passkey.settings.limit", { max: d.success ? d.data.max : PASSKEY_MAX_PER_USER });
  }
  if (isApiError(e, "passkey_exists")) return t("passkey.settings.exists");
  if (isApiError(e, "passkey_unavailable_for_account")) {
    return t("passkey.settings.unavailableForAccount");
  }
  if (isApiError(e, "passkey_failed")) return t("passkey.settings.failed");
  return errorMessage(e);
}
