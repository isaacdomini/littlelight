import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";

// "Done" leaves the family album and returns to the parent app (docs/plans/step-9.md 2.7, 2.15).

const clearViewerSession = vi.hoisted(() => vi.fn());
vi.mock("../../lib/shareApi", () => ({ clearViewerSession }));

import { NativeDone } from "./NativeDone";

const assign = vi.fn();
beforeEach(() => {
  clearViewerSession.mockClear();
  assign.mockClear();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.unstubAllGlobals();
});

describe("NativeDone", () => {
  it("renders nothing on the web (the browser's own back/close does the job)", () => {
    setNativePlatform(null);
    const { container } = render(<NativeDone />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("share-done")).toBeNull();
  });

  it.each(["ios", "android"] as const)("on %s it shows Done", (platform) => {
    setNativePlatform(platform);
    render(<NativeDone />);
    expect(screen.getByTestId("share-done").textContent).toBe("Done");
  });

  it("tapping Done forgets the in-memory viewer session, then navigates to the app root", () => {
    setNativePlatform("ios");
    render(<NativeDone />);
    fireEvent.click(screen.getByTestId("share-done"));
    expect(clearViewerSession).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/");
    expect(clearViewerSession.mock.invocationCallOrder[0]).toBeLessThan(
      assign.mock.invocationCallOrder[0] as number,
    );
  });

  it("passes the button variant through", () => {
    setNativePlatform("ios");
    render(<NativeDone variant="primary" />);
    expect(screen.getByTestId("share-done").className).toContain("primary");
  });
});
