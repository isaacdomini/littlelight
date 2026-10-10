import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleConnectedPage, isGoogleConnectedPath } from "./GoogleConnectedPage";

// Where Google's consent ends (docs/plans/step-10.md 2.11, D15): it makes no API call, parses the
// query defensively, returns web users to the app after a moment and tells native users to close
// the browser sheet.

const replace = vi.fn();
const assign = vi.fn();

function show(search: string) {
  window.history.replaceState(null, "", `/import/google/connected${search}`);
  vi.stubGlobal("location", { ...window.location, replace, assign });
  return render(
    <MemoryRouter>
      <GoogleConnectedPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  replace.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isGoogleConnectedPath", () => {
  it.each([
    ["/import/google/connected", true],
    ["/import/google/connected/", true],
    ["/import/google/other", false],
    ["/settings/import", false],
    ["/", false],
  ])("%s", (p, ok) => {
    expect(isGoogleConnectedPath(p)).toBe(ok);
  });
});

describe("GoogleConnectedPage", () => {
  it("web ok: says connected, goes back to the app on its own after a moment, makes no API call", () => {
    show("?status=ok&client=web&returnTo=%2Fsettings%2Fimport");
    expect(screen.getByText("Google Photos connected")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(replace).toHaveBeenCalledWith("/settings/import");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("web: the back button goes to the return path", () => {
    show("?status=ok&client=web&returnTo=%2Fupload");
    fireEvent.click(screen.getByTestId("google-connected-back"));
    expect(assign).toHaveBeenCalledWith("/upload");
  });

  it("native ok: 'Return to Littlelight', no auto navigation, no button", () => {
    show("?status=ok&client=native");
    expect(screen.getByText("Connected. Return to Littlelight.")).toBeTruthy();
    expect(screen.getByTestId("google-connected-native")).toBeTruthy();
    expect(screen.queryByTestId("google-connected-back")).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", "Google Photos wasn't connected"],
    ["scope_missing", "Almost there"],
    ["expired", "That link timed out"],
    ["error", "Couldn't connect Google Photos"],
  ])("%s shows its message and does not redirect", (status, title) => {
    show(`?status=${status}&client=web`);
    expect(screen.getByText(title)).toBeTruthy();
    vi.advanceTimersByTime(5000);
    expect(replace).not.toHaveBeenCalled();
  });

  it("unknown values fall back safely: status=error, web, /upload", () => {
    show("?status=hacked&client=tv&returnTo=https%3A%2F%2Fevil.test");
    expect(screen.getByText("Couldn't connect Google Photos")).toBeTruthy();
    fireEvent.click(screen.getByTestId("google-connected-back"));
    expect(assign).toHaveBeenCalledWith("/upload");
  });

  it("an off-list return path is never followed, even with status=ok", () => {
    show("?status=ok&client=web&returnTo=%2F%2Fevil.test%2Fx");
    vi.advanceTimersByTime(2000);
    expect(replace).toHaveBeenCalledWith("/upload");
  });

  it("no query at all is the error page", () => {
    show("");
    expect(screen.getByText("Couldn't connect Google Photos")).toBeTruthy();
  });
});
