import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../../testing/native";

// Share URL body on native (docs/plans/step-9.md 2.7, 2.15): the OS share sheet is always
// available, a light haptic confirms the new link, and the URL is never logged.

const nativeShare = vi.hoisted(() => ({ shareLink: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticSuccess: vi.fn() }));
vi.mock("../../platform/native/share", () => nativeShare);
vi.mock("../../lib/haptics", () => haptics);

import { ShareUrlBody } from "./ShareUrlSheet";

const URL_ = "https://tinyglow.app/s/AbCdEfGhIjKlMnOpQrStUv";

beforeEach(() => {
  nativeShare.shareLink.mockReset().mockResolvedValue(true);
  haptics.hapticSuccess.mockReset();
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
  vi.restoreAllMocks();
});

describe("ShareUrlBody on native", () => {
  it("always offers Share (even without navigator.share) and sends the url to the OS sheet", async () => {
    setNativePlatform("ios");
    render(<ShareUrlBody url={URL_} onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId("share-native"));
    await waitFor(() => expect(nativeShare.shareLink).toHaveBeenCalledTimes(1));
    expect(nativeShare.shareLink.mock.calls[0]?.[0]).toMatchObject({ url: URL_ });
  });

  it("a dismissed sheet is not an error", async () => {
    setNativePlatform("android");
    nativeShare.shareLink.mockResolvedValue(false);
    render(<ShareUrlBody url={URL_} onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId("share-native"));
    await waitFor(() => expect(nativeShare.shareLink).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gives a light success haptic when the link is shown", () => {
    setNativePlatform("ios");
    render(<ShareUrlBody url={URL_} onDone={vi.fn()} />);
    expect(haptics.hapticSuccess).toHaveBeenCalledTimes(1);
  });

  it("still shows the copy button, the one-time notice and Done", () => {
    setNativePlatform("ios");
    const onDone = vi.fn();
    render(<ShareUrlBody url={URL_} onDone={onDone} />);
    expect(screen.getByTestId("share-copy")).toBeTruthy();
    expect(screen.getByTestId("share-url-once")).toBeTruthy();
    expect((screen.getByTestId("share-url-value") as HTMLInputElement).value).toBe(URL_);
    fireEvent.click(screen.getByTestId("share-url-done"));
    expect(onDone).toHaveBeenCalled();
  });

  it("never writes the url to storage or the console", async () => {
    setNativePlatform("ios");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    render(<ShareUrlBody url={URL_} onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId("share-native"));
    await waitFor(() => expect(nativeShare.shareLink).toHaveBeenCalled());
    expect(setItem).not.toHaveBeenCalled();
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("AbCdEf");
  });
});

describe("ShareUrlBody on the web (control)", () => {
  it("hides Share when the browser has no share sheet", () => {
    setNativePlatform(null);
    render(<ShareUrlBody url={URL_} onDone={vi.fn()} />);
    expect(screen.queryByTestId("share-native")).toBeNull();
    expect(haptics.hapticSuccess).not.toHaveBeenCalled();
  });

  it("uses navigator.share when present and falls back to copy on a real failure, not on cancel", async () => {
    setNativePlatform(null);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("cancel", "AbortError"))
      .mockRejectedValueOnce(new Error("boom"));
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<ShareUrlBody url={URL_} onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId("share-native"));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("share-native"));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_));
    expect(nativeShare.shareLink).not.toHaveBeenCalled();
  });
});
