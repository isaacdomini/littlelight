import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// A member whose profile is gone or mid-deletion has an empty display name (member_profiles
// returns '' while deletion is in progress, docs/plans/review-fixes.md 2.8): the list must stay
// readable.

const BABY = "11111111-1111-4111-8111-111111111111";
const ME = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ me: { user: { id: "33333333-3333-4333-8333-333333333333" }, babies: [] } }),
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Maya",
      nickname: null,
      role: "admin",
      plan: "free",
    },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  ME_KEY: ["me"],
}));
vi.mock("../auth/FreshSignInGate", () => ({
  useFreshSignIn: () => async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../components/AiUsage", () => ({ AiUsage: () => null }));
vi.mock("../components/share/ShareLinksSection", () => ({ ShareLinksSection: () => null }));

import { FamilyPage } from "./FamilyPage";

const member = (userId: string, displayName: string, role = "admin") => ({
  userId,
  displayName,
  relationshipLabel: null,
  role,
  joinedAt: "2026-01-01T00:00:00.000Z",
  removalRequestedBy: null,
  removalRequestedAt: null,
});

let members: unknown[] = [];
beforeEach(() => {
  setNativePlatform(null);
  stubFetch((c) =>
    c.url.endsWith(`/babies/${BABY}/members`)
      ? jsonResponse({ members, invites: [] })
      : jsonResponse({ error: "not_found", message: "x" }, 404),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  const r = renderApp(<FamilyPage />, { route: "/family" });
  await ionReady(r.container);
  return r;
}

describe("FamilyPage members", () => {
  it("lists named members with their initial", async () => {
    members = [member(ME, "Mom"), member(OTHER, "Dad")];
    await open();
    await waitFor(() => expect(screen.getByText(/^Dad/)).toBeTruthy());
    expect(screen.getByText(/^Mom/)).toBeTruthy();
  });

  it("an empty display name reads as a former member, with an initial, never blank", async () => {
    members = [member(ME, "Mom"), member(OTHER, "", "contributor")];
    await open();
    await waitFor(() => expect(screen.getByText("Former member")).toBeTruthy());
    const row = screen.getByText("Former member").closest("li");
    expect(row?.textContent).toContain("F"); // avatar initial of the fallback
  });

  it("whitespace-only names are treated the same", async () => {
    members = [member(ME, "Mom"), member(OTHER, "   ", "contributor")];
    await open();
    await waitFor(() => expect(screen.getByText("Former member")).toBeTruthy());
  });
});
