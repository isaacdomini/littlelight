import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

vi.mock("../../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({
    baby: { id: "b1", name: "Mia" },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  useAuth: () => ({ me: null }),
}));

import { FirstUploadPage } from "./FirstUploadPage";

afterEach(() => {
  cleanup();
  setNativePlatform(null);
  window.localStorage.clear();
});

describe("FirstUploadPage primer", () => {
  it("native: says Littlelight only receives the photos you pick", async () => {
    setNativePlatform("ios");
    const { container } = renderApp(<FirstUploadPage />, { route: "/onboarding/first-upload" });
    await ionReady(container);
    expect(screen.getByTestId("primer").textContent).toContain(
      "Littlelight only receives the photos you pick",
    );
  });

  it("web: the web primer text", async () => {
    setNativePlatform(null);
    const { container } = renderApp(<FirstUploadPage />, { route: "/onboarding/first-upload" });
    await ionReady(container);
    expect(screen.getByTestId("primer").textContent).not.toContain(
      "only receives the photos you pick",
    );
  });

  it("choosing goes to /upload and later goes to /timeline, marking onboarding done", async () => {
    setNativePlatform("ios");
    const a = renderApp(<FirstUploadPage />, { route: "/onboarding/first-upload" });
    await ionReady(a.container);
    fireEvent.click(screen.getByTestId("primer-continue"));
    expect(a.location()).toBe("/upload");
    expect(window.localStorage.getItem("onboardingDone:b1")).toBe("1");
    cleanup();
    const b = renderApp(<FirstUploadPage />, { route: "/onboarding/first-upload" });
    await ionReady(b.container);
    fireEvent.click(screen.getByTestId("primer-later"));
    expect(b.location()).toBe("/timeline");
  });
});
