import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UploadItem } from "../lib/upload/manager";
import { setNativePlatform } from "../testing/native";
import { UploadRow } from "./UploadRow";

// Failure wording of an upload row, including the guest pending queue (docs/plans/step-11.md 2.8).

afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

const failed = (error: UploadItem["error"], retryable = false): UploadItem => ({
  clientId: "c1",
  lane: "user",
  babyId: "11111111-1111-4111-8111-111111111111",
  name: "IMG_1.jpg",
  size: 2048,
  kind: "photo",
  wifiOnly: false,
  state: "failed",
  progress: 0,
  error,
  retryable,
});
const label = () => screen.getByTestId("upload-row-c1").textContent ?? "";
const view = (item: UploadItem) =>
  render(
    <ul>
      <UploadRow item={item} onRetry={() => undefined} onCancel={() => undefined} />
    </ul>,
  );

describe("UploadRow errors", () => {
  it("pending_limit: wait for a parent to review, not retryable", () => {
    view(failed("pending_limit"));
    expect(label()).toMatch(/waiting for approval/i);
    expect(label()).toMatch(/wait for a parent to review/i);
    expect(screen.queryByText(/retry/i)).toBeNull();
  });

  it("pending_limit reads the same on native (no purchase wording)", () => {
    setNativePlatform("ios");
    view(failed("pending_limit"));
    expect(label()).toMatch(/waiting for approval/i);
    expect(label()).not.toMatch(/upgrade|plus/i);
  });

  it("free_tier_limit: web may mention Plus, native never does", () => {
    view(failed("free_tier_limit"));
    expect(label()).toMatch(/full/i);
    cleanup();
    setNativePlatform("android");
    view(failed("free_tier_limit"));
    expect(label()).toMatch(/full/i);
    expect(label()).not.toMatch(/upgrade|plus/i);
  });

  it("pending_limit and free_tier_limit are different messages", () => {
    view(failed("pending_limit"));
    const a = label();
    cleanup();
    view(failed("free_tier_limit"));
    expect(label()).not.toBe(a);
  });
});
