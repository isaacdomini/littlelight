import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Creating the first album is where the family-start checks run (docs/plans/step-11.md 2.8,
// 2.9): three refusals render inline in `baby-error`.

vi.mock("../../auth/AuthProvider", () => ({
  ME_KEY: ["me"],
  useAuth: () => ({
    me: { profile: { units: "metric" } },
    refetchMe: vi.fn().mockResolvedValue(null),
    setCurrentBabyId: vi.fn(),
  }),
}));

import { BabyPage } from "./BabyPage";

beforeEach(() => setNativePlatform(null));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndSubmit() {
  const r = renderApp(<BabyPage />, { route: "/onboarding/baby" });
  await ionReady(r.container);
  fireEvent.change(screen.getByTestId("baby-name"), { target: { value: "Mia" } });
  fireEvent.change(screen.getByTestId("baby-birthdate"), { target: { value: "2026-03-01" } });
  fireEvent.click(screen.getByTestId("baby-create"));
  return r;
}
const errorText = async () => {
  await waitFor(() => expect(screen.getByTestId("baby-error")).toBeTruthy());
  return screen.getByTestId("baby-error").textContent ?? "";
};

describe("BabyPage: family start refusals", () => {
  it("400 email_not_allowed: temporary addresses can't start a family", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ error: "email_not_allowed", message: "server text" }, 400),
    );
    await fillAndSubmit();
    const msg = await errorText();
    expect(msg).toMatch(/disposable email addresses can't start a family/i);
    expect(msg).toMatch(/join a family as a guest/i);
    expect(calls.some((c) => c.url.endsWith("/babies") && c.method === "POST")).toBe(true);
  });

  it("409 inbox_has_family: shows the masked address", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: "inbox_has_family",
          message: "x",
          details: { existingEmailMasked: "m***@gmail.com" },
        },
        409,
      ),
    );
    await fillAndSubmit();
    const msg = await errorText();
    expect(msg).toContain("m***@gmail.com");
    expect(msg).toMatch(/already has a family/i);
  });

  it("429 family_limited: says when to try again, from Retry-After", async () => {
    stubFetch(() =>
      jsonResponse({ error: "family_limited", message: "x" }, 429, { "retry-after": "7200" }),
    );
    await fillAndSubmit();
    const msg = await errorText();
    expect(msg).toMatch(/too many new families/i);
    expect(msg).toMatch(/in about 2 hours/);
  });

  it("the form stays usable after a refusal (submit enabled again)", async () => {
    stubFetch(() => jsonResponse({ error: "email_not_allowed", message: "x" }, 400));
    await fillAndSubmit();
    await errorText();
    await waitFor(() =>
      expect((screen.getByTestId("baby-create") as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
