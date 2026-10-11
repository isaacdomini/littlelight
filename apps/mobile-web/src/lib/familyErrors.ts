import { inboxHasFamilyDetailsSchema, pendingLimitDetailsSchema } from "@tinyglow/shared";
import { t } from "../i18n";
import { ApiError, errorMessage } from "./api";
import { retryWhen } from "./signInErrors";

/**
 * Copy for the refusals of "start a family" (`POST /babies` for the first album; docs/plans/
 * step-11.md 2.9). Anything else passes through `errorMessage`.
 */
export function familyStartError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "email_not_allowed") return t("family.err.email_not_allowed");
    if (e.code === "inbox_has_family") {
      const d = inboxHasFamilyDetailsSchema.safeParse(e.details);
      return d.success
        ? t("family.err.inbox_has_family", { masked: d.data.existingEmailMasked })
        : t("family.err.inbox_has_family.nohint");
    }
    if (e.code === "family_limited") {
      return e.retryAfterSec
        ? t("family.err.family_limited.when", { when: retryWhen(e.retryAfterSec) })
        : t("family.err.family_limited");
    }
  }
  return errorMessage(e);
}

/**
 * `already_parent_elsewhere` from accepting a parent invite (`invitee`) or promoting a member
 * to parent (`promoter`).
 */
export function memberError(e: unknown, who: "invitee" | "promoter", name?: string | null): string {
  if (e instanceof ApiError && e.code === "already_parent_elsewhere") {
    const n = name?.trim();
    if (who === "promoter" && n)
      return t("family.err.already_parent_elsewhere.promoter.named", { name: n });
    return t(`family.err.already_parent_elsewhere.${who}`);
  }
  return errorMessage(e);
}

/** Guest upload refusal with the counts when the server sent them. */
export function pendingLimitMessage(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== "pending_limit") return null;
  const d = pendingLimitDetailsSchema.safeParse(e.details);
  return d.success
    ? t("upload.err.pending_limit.counts", { pending: d.data.pending, limit: d.data.limit })
    : t("upload.err.pending_limit");
}

/** 409 `free_tier_limit` when approving a guest's photo into a full family. */
export function approveError(e: unknown, native: boolean): string {
  if (e instanceof ApiError && e.code === "free_tier_limit") {
    return t(native ? "approve.err.free_tier_limit.native" : "approve.err.free_tier_limit");
  }
  return errorMessage(e);
}
