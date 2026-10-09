import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Sign-in screen on native (docs/plans/step-9.md 2.5, 2.15): email code only until Apple/Google
// sign-in lands in the app, so the provider buttons are hidden there.

const config = vi.hoisted(() => ({
  data: { providers: { apple: true, google: true }, turnstileSiteKey: null } as
    | {
        providers: { apple: boolean; google: boolean };
        turnstileSiteKey: string | null;
      }
    | undefined,
}));
vi.mock("../../lib/queries", () => ({ useAuthConfig: () => ({ data: config.data }) }));

import { WelcomePage } from "./WelcomePage";

afterEach(() => {
  cleanup();
  setNativePlatform(null);
  config.data = { providers: { apple: true, google: true }, turnstileSiteKey: null };
});

describe("WelcomePage providers", () => {
  it("web shows the Apple and Google buttons when the server offers them", async () => {
    setNativePlatform(null);
    const { container } = renderApp(<WelcomePage />, { route: "/welcome" });
    await ionReady(container);
    expect(screen.getByTestId("welcome-apple")).toBeTruthy();
    expect(screen.getByTestId("welcome-google")).toBeTruthy();
  });

  it.each(["ios", "android"] as const)(
    "%s hides both provider buttons and the divider",
    async (platform) => {
      setNativePlatform(platform);
      const { container } = renderApp(<WelcomePage />, { route: "/welcome" });
      await ionReady(container);
      expect(screen.queryByTestId("welcome-apple")).toBeNull();
      expect(screen.queryByTestId("welcome-google")).toBeNull();
      expect(container.textContent).not.toContain("Continue with Apple");
      expect(container.textContent).not.toContain("Continue with Google");
      // the email code form is still there
      expect(screen.getByTestId("welcome-email")).toBeTruthy();
      expect(screen.getByTestId("welcome-continue")).toBeTruthy();
    },
  );

  it("web with providers off shows only the email form", async () => {
    setNativePlatform(null);
    config.data = { providers: { apple: false, google: false }, turnstileSiteKey: null };
    const { container } = renderApp(<WelcomePage />, { route: "/welcome" });
    await ionReady(container);
    expect(screen.queryByTestId("welcome-apple")).toBeNull();
    expect(screen.getByTestId("welcome-email")).toBeTruthy();
  });
});
