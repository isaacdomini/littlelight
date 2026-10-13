import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VIDEO_LARGE_FILE_BYTES } from "@tinyglow/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadItem } from "../lib/upload/manager";
import { setNativePlatform } from "../testing/native";
import { UploadRow } from "./UploadRow";

// Upload rows for videos (docs/plans/step-12.md 2.8, Q6, 2.11): kind + duration, the video glyph,
// the per-plan failure copy (no Plus wording on native), and the "Use cellular" switch for large
// videos on native only, before the transfer starts.

afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

const item = (over: Partial<UploadItem> = {}): UploadItem => ({
  clientId: "v1",
  lane: "user",
  babyId: "11111111-1111-4111-8111-111111111111",
  name: "clip.mov",
  size: 20 * 1024 * 1024,
  kind: "video",
  durationMs: 42_000,
  wifiOnly: false,
  state: "queued",
  progress: 0,
  error: null,
  retryable: false,
  ...over,
});
const text = () => screen.getByTestId("upload-row-v1").textContent ?? "";
const view = (it: UploadItem, onWifiOnly?: (id: string, wifiOnly: boolean) => void) =>
  render(
    <ul>
      <UploadRow
        item={it}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onWifiOnly={onWifiOnly}
      />
    </ul>,
  );

describe("UploadRow: video", () => {
  it("shows the video glyph, kind and duration, and marks the row data-kind=video", () => {
    view(item());
    expect(screen.getByTestId("upload-video-icon-v1")).toBeTruthy();
    expect(screen.getByTestId("upload-kind-v1").textContent).toBe("Video · 0:42");
    expect(screen.getByTestId("upload-row-v1").getAttribute("data-kind")).toBe("video");
  });

  it("without a duration hint it says Video; photos have neither glyph nor kind text", () => {
    view(item({ durationMs: undefined }));
    expect(screen.getByTestId("upload-kind-v1").textContent).toBe("Video");
    cleanup();
    view(item({ kind: "photo", durationMs: undefined, name: "a.jpg" }));
    expect(screen.queryByTestId("upload-video-icon-v1")).toBeNull();
    expect(screen.queryByTestId("upload-kind-v1")).toBeNull();
  });

  it("video_too_long on the web mentions the free minute and Plus; on native no Plus wording", () => {
    view(item({ state: "failed", error: "video_too_long", plan: "free" } as Partial<UploadItem>));
    expect(text()).toMatch(/1 minute/i);
    expect(text()).toMatch(/Plus/);
    cleanup();
    setNativePlatform("ios");
    view(item({ state: "failed", error: "video_too_long", plan: "free" } as Partial<UploadItem>));
    expect(text()).toMatch(/1 minute/i);
    expect(text()).not.toMatch(/Plus|upgrade/i);
    cleanup();
    // Plus (or an unknown plan): the absolute wording, no upgrade talk anywhere
    setNativePlatform(null);
    view(item({ state: "failed", error: "video_too_long", plan: "plus" } as Partial<UploadItem>));
    expect(text()).toMatch(/5 minutes and 2 GB/);
    expect(text()).not.toMatch(/upgrade/i);
  });

  it("transcode_failed is a failure line without a retry (the row stays live)", () => {
    view(item({ state: "failed", error: "transcode_failed", retryable: false }));
    expect(text()).toMatch(/couldn't be prepared|prepared for playback/i);
    expect(screen.queryByTestId("upload-retry-v1")).toBeNull();
  });

  it("the cellular switch: native, large video, before transfer; toggling reports the new wifiOnly", () => {
    setNativePlatform("ios");
    const spy = vi.fn();
    view(item({ size: VIDEO_LARGE_FILE_BYTES + 1, wifiOnly: true }), spy);
    const label = screen.getByTestId("upload-cellular-v1");
    expect(label.textContent).toContain("Videos over 50 MB upload on Wi-Fi.");
    const box = label.querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(false); // wifiOnly => cellular unchecked
    fireEvent.click(box);
    expect(spy).toHaveBeenCalledWith("v1", false);
  });

  it("no switch for small videos, for photos, on the web, or once uploading", () => {
    setNativePlatform("android");
    const spy = vi.fn();
    view(item({ size: VIDEO_LARGE_FILE_BYTES - 1 }), spy);
    expect(screen.queryByTestId("upload-cellular-v1")).toBeNull();
    cleanup();
    view(item({ size: VIDEO_LARGE_FILE_BYTES + 1, kind: "photo", durationMs: undefined }), spy);
    expect(screen.queryByTestId("upload-cellular-v1")).toBeNull();
    cleanup();
    view(item({ size: VIDEO_LARGE_FILE_BYTES + 1, state: "uploading", progress: 0.4 }), spy);
    expect(screen.queryByTestId("upload-cellular-v1")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    cleanup();
    setNativePlatform(null);
    view(item({ size: VIDEO_LARGE_FILE_BYTES + 1 }), spy);
    expect(screen.queryByTestId("upload-cellular-v1")).toBeNull();
  });
});
