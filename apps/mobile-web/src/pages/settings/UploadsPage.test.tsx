import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cellularForLargeVideos } from "../../lib/upload/prefs";
import { ionReady, renderApp } from "../../testing/render";
import { UploadsPage } from "./UploadsPage";

// Settings -> Uploads (docs/plans/step-12.md Q6): the persisted "Use cellular for large videos"
// switch. Default off (Wi-Fi only); the stored value is a bare marker, no ids or names.

const KEY = "ll.upload.cellular.v1";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("UploadsPage", () => {
  it("renders the switch off by default with its hint", async () => {
    const { container } = renderApp(<UploadsPage />, { route: "/settings/uploads" });
    await ionReady(container);
    expect(screen.getByTestId("uploads-settings")).toBeTruthy();
    const box = screen.getByTestId("uploads-cellular") as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(false);
    expect(container.textContent).toContain("Use cellular for large videos");
    expect(cellularForLargeVideos()).toBe(false);
  });

  it("turning it on persists a bare '1' marker and re-renders checked; off removes the key", async () => {
    const { container } = renderApp(<UploadsPage />, { route: "/settings/uploads" });
    await ionReady(container);
    const box = screen.getByTestId("uploads-cellular") as HTMLInputElement;
    fireEvent.click(box);
    expect(window.localStorage.getItem(KEY)).toBe("1");
    expect(cellularForLargeVideos()).toBe(true);
    expect((screen.getByTestId("uploads-cellular") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("uploads-cellular"));
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(cellularForLargeVideos()).toBe(false);
    expect((screen.getByTestId("uploads-cellular") as HTMLInputElement).checked).toBe(false);
  });

  it("reflects a preference stored before mount", async () => {
    window.localStorage.setItem(KEY, "1");
    const { container } = renderApp(<UploadsPage />, { route: "/settings/uploads" });
    await ionReady(container);
    expect((screen.getByTestId("uploads-cellular") as HTMLInputElement).checked).toBe(true);
  });
});
