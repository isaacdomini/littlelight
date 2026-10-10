import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";
import { NativeSignInPage } from "./NativeSignInPage";

// /signin/native (docs/plans/step-9.md 2.4, 2.15): explains where the link belongs on the web,
// is a placeholder in the app, never reads the URL's query or fragment.

const replace = vi.fn();
beforeEach(() => {
  replace.mockClear();
  vi.stubGlobal("location", { ...window.location, replace });
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllGlobals();
});

describe("NativeSignInPage", () => {
  it("web: says to open the link on the phone, with a secondary Back button", async () => {
    setNativePlatform(null);
    const { container } = renderApp(<NativeSignInPage />, { route: "/signin/native" });
    await ionReady(container);
    expect(screen.getByTestId("native-signin")).toBeTruthy();
    expect(container.textContent).toContain(
      "Open this link on your phone with the Tinyglow app installed.",
    );
    expect(screen.getByTestId("native-signin-back").className).toContain("secondary");
  });

  it("app: shows the in-app body with a primary Back button", async () => {
    setNativePlatform("ios");
    const { container } = renderApp(<NativeSignInPage />, { route: "/signin/native" });
    await ionReady(container);
    expect(container.textContent).not.toContain("Open this link on your phone");
    expect(screen.getByTestId("native-signin-back").className).toContain("primary");
  });

  it("Back goes to /welcome", async () => {
    setNativePlatform("ios");
    const { container } = renderApp(<NativeSignInPage />, { route: "/signin/native" });
    await ionReady(container);
    fireEvent.click(screen.getByTestId("native-signin-back"));
    expect(replace).toHaveBeenCalledWith("/welcome");
  });

  it("never renders or stores anything from the query or fragment", async () => {
    setNativePlatform("ios");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = renderApp(<NativeSignInPage />, {
      route: "/signin/native?code=SECRET-CODE&state=SECRET-STATE",
    });
    await ionReady(container);
    expect(screen.getByTestId("native-signin").textContent).not.toContain("SECRET");
    expect(setItem).not.toHaveBeenCalled();
  });
});
