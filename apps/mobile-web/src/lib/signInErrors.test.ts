import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { retryWhen, signInError } from "./signInErrors";

// Sign-in is never refused for abuse reasons any more (docs/plans/step-11.md 2.8): the old
// sign-up-time branches are gone, so family codes are NOT special-cased here.

describe("signInError", () => {
  it("passes the server message through", () => {
    expect(
      signInError(new ApiError(400, "validation_failed", "That code is not right")).message,
    ).toBe("That code is not right");
  });

  it("gives a generic line for non-API errors", () => {
    expect(signInError(new Error("internals")).message).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("a family-start code arriving here (it should not) is shown as-is, with no sign-in-with-that-address state", () => {
    const out = signInError(new ApiError(409, "inbox_has_family", "Another account has a family"));
    expect(Object.keys(out)).toEqual(["message"]);
    expect(out.message).toBe("Another account has a family");
  });
});

describe("retryWhen", () => {
  it("minutes under 90, then hours", () => {
    expect(retryWhen(30)).toBe("1 minute");
    expect(retryWhen(40 * 60)).toBe("40 minutes");
    expect(retryWhen(89 * 60)).toBe("89 minutes");
    expect(retryWhen(90 * 60)).toBe("2 hours");
    expect(retryWhen(5 * 3600)).toBe("5 hours");
    expect(retryWhen(3600 + 1)).toBe("60 minutes");
  });
});
