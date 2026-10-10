import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Account deletion screen (docs/plans/step-10.md 2.11, 10.10): the consequences list names the
// Google Photos connection (revoked and removed) only when there is one.

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: null, clearSession: vi.fn() }),
  ME_KEY: ["me"],
}));
vi.mock("../../auth/FreshSignInGate", () => ({
  useFreshSignIn: () => async (fn: () => Promise<unknown>) => fn(),
}));

import { AccountPage } from "./AccountPage";

let preview: Record<string, unknown> = {};
beforeEach(() => {
  preview = { blockingBabies: [], babiesKept: [], freshSignIn: true, googlePhotosConnected: false };
  stubFetch((c) =>
    c.url.endsWith("/me/deletion-preview") ? jsonResponse(preview) : jsonResponse({}, 404),
  );
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllGlobals();
});

async function toConsequences() {
  const r = renderApp(<AccountPage />, { route: "/settings/account" });
  await ionReady(r.container);
  await waitFor(() => expect(screen.getByTestId("account-continue")).toBeTruthy());
  fireEvent.click(screen.getByTestId("account-continue"));
}

describe("AccountPage: Google Photos connection line", () => {
  it("is listed when the account has a connection", async () => {
    preview.googlePhotosConnected = true;
    await toConsequences();
    await waitFor(() =>
      expect(screen.getByTestId("account-google").textContent).toBe(
        "Your Google Photos connection is revoked at Google and removed.",
      ),
    );
  });

  it("is absent when there is none", async () => {
    await toConsequences();
    await waitFor(() => expect(screen.getByTestId("account-ack")).toBeTruthy());
    expect(screen.queryByTestId("account-google")).toBeNull();
  });

  it("is absent against an older server that does not send the field", async () => {
    preview = { blockingBabies: [], babiesKept: [], freshSignIn: true };
    await toConsequences();
    await waitFor(() => expect(screen.getByTestId("account-ack")).toBeTruthy());
    expect(screen.queryByTestId("account-google")).toBeNull();
  });
});
