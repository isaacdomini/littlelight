import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, errorMessage } from "../lib/api";
import {
  approveError,
  familyStartError,
  memberError,
  pendingLimitMessage,
} from "../lib/familyErrors";
import type { UploadItem } from "../lib/upload/manager";
import { setNativePlatform } from "../testing/native";
import { UploadRow } from "./UploadRow";

// The native apps never prompt to buy Plus (store billing rules; docs/plans/step-11.md 2.8, 2.9).
// Guard: every error path a native user can reach is free of "Upgrade" and "Plus".

afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

const NO_PURCHASE = /upgrade|plus\b|subscribe|buy/i;
const CODES = [
  "free_tier_limit",
  "pending_limit",
  "email_not_allowed",
  "inbox_has_family",
  "family_limited",
  "already_parent_elsewhere",
] as const;

describe("native copy has no purchase wording", () => {
  for (const platform of ["ios", "android"] as const) {
    it(`${platform}: errorMessage / approveError / familyStartError / memberError`, () => {
      setNativePlatform(platform);
      for (const code of CODES) {
        const e = new ApiError(
          409,
          code,
          "server text",
          { pending: 1, limit: 2, existingEmailMasked: "m***@x.com" },
          60,
        );
        for (const m of [
          errorMessage(e),
          approveError(e, true),
          familyStartError(e),
          memberError(e, "invitee"),
          memberError(e, "promoter"),
          pendingLimitMessage(e) ?? "",
        ]) {
          expect(m, `${code}: ${m}`).not.toMatch(NO_PURCHASE);
        }
      }
    });

    it(`${platform}: UploadRow failures`, () => {
      setNativePlatform(platform);
      for (const error of [
        "free_tier_limit",
        "pending_limit",
        "rejected",
        "storage_error",
        "network",
        "unknown",
      ] as const) {
        const item: UploadItem = {
          clientId: "c1",
          lane: "user",
          babyId: "b",
          name: "a.jpg",
          size: 1,
          state: "failed",
          progress: 0,
          error,
          retryable: false,
        };
        render(
          <ul>
            <UploadRow item={item} onRetry={() => undefined} onCancel={() => undefined} />
          </ul>,
        );
        expect(screen.getByTestId("upload-row-c1").textContent ?? "", error).not.toMatch(
          NO_PURCHASE,
        );
        cleanup();
      }
    });
  }
});
