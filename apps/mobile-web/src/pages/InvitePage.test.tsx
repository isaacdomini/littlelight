import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../testing/native";
import { ionReady, renderApp } from "../testing/render";

// Accepting an invite as a parent who already runs another family (docs/plans/step-11.md 2.8,
// 2.9): the 409 already_parent_elsewhere explains itself and offers to switch accounts.

const TOKEN = "t".repeat(43);
const signOut = vi.hoisted(() => vi.fn());
const refetchMe = vi.hoisted(() => vi.fn());

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    me: {
      user: { id: "u1", email: "dad@example.test" },
      consent: { ok: true },
      profileComplete: true,
      babies: [{ id: "b-own", name: "Own" }],
    },
    isLoading: false,
    refetchMe,
    setCurrentBabyId: vi.fn(),
  }),
}));
vi.mock("../auth/guards", () => ({ useRouteActive: () => true }));
vi.mock("../auth/useSignOut", () => ({ useSignOut: () => signOut }));

import { InvitePage } from "./InvitePage";

const lookup = (role: "admin" | "contributor") => ({
  status: "valid",
  babyName: "Mia",
  inviterName: "Maria",
  role,
  maskedEmail: "d***@example.test",
  expiresAt: "2026-12-01T00:00:00.000Z",
});

function stubInvite(role: "admin" | "contributor", accept: () => Response) {
  return stubFetch((c) => {
    if (c.url.endsWith(`/invites/${TOKEN}`)) return jsonResponse(lookup(role));
    if (c.url.endsWith(`/invites/${TOKEN}/accept`)) return accept();
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
}

async function open() {
  const r = renderApp(<InvitePage />, { route: `/invite/${TOKEN}` });
  // /invite/:token needs a route param
  await ionReady(r.container);
  return r;
}

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useParams: () => ({ token: TOKEN }),
}));

beforeEach(() => {
  signOut.mockReset();
  refetchMe.mockReset().mockResolvedValue(null);
  setNativePlatform(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InvitePage: already a parent elsewhere", () => {
  it("shows the explanation and a switch-account button that signs out locally", async () => {
    stubInvite("admin", () =>
      jsonResponse({ error: "already_parent_elsewhere", message: "server text" }, 409),
    );
    await open();
    await waitFor(() => expect(screen.getByTestId("invite-failed")).toBeTruthy());
    const msg = screen.getByTestId("invite-failed").textContent ?? "";
    expect(msg).toMatch(/already a parent in another family/i);
    expect(msg).toMatch(/different account/i);
    expect(msg).toMatch(/guest/i);
    fireEvent.click(screen.getByTestId("invite-switch-account"));
    expect(signOut).toHaveBeenCalledWith("local");
  });

  it("other failures show their message and no switch-account button", async () => {
    stubInvite("admin", () => jsonResponse({ error: "admins_full", message: "x" }, 409));
    await open();
    await waitFor(() => expect(screen.getByTestId("invite-failed")).toBeTruthy());
    expect(screen.queryByTestId("invite-switch-account")).toBeNull();
  });

  it("a guest invite is accepted normally for the same person", async () => {
    stubInvite("contributor", () =>
      jsonResponse({ babyId: "22222222-2222-4222-8222-222222222222", role: "contributor" }),
    );
    await open();
    await waitFor(() => expect(screen.getByTestId("invite-joined")).toBeTruthy());
    expect(screen.queryByTestId("invite-failed")).toBeNull();
    expect(screen.queryByTestId("invite-switch-account")).toBeNull();
  });
});
