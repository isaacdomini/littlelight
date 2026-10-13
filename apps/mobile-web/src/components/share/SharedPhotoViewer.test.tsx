import { cleanup, render, screen } from "@testing-library/react";
import type { ViewerPhoto } from "@tinyglow/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// The viewer's capture date is a UTC calendar date (docs/plans/review-fixes.md D19): it must read
// the same in every browser time zone, never shifted by the local offset.

vi.mock("../../lib/shareApi", () => ({
  fetchShareUrls: vi.fn(async () => ({ urls: [] })),
  fetchShareDownload: vi.fn(),
}));
vi.mock("swiper/react", () => ({
  Swiper: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SwiperSlide: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("swiper/modules", () => ({ Keyboard: {}, Virtual: {}, Zoom: {} }));
vi.mock("swiper/css", () => ({}));
vi.mock("swiper/css/virtual", () => ({}));
vi.mock("swiper/css/zoom", () => ({}));

import { SharedPhotoViewer } from "./SharedPhotoViewer";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photo = (takenAt: string | null): ViewerPhoto => ({
  id: ID,
  mediaKind: "photo",
  durationMs: null,
  takenAt,
  takenAtEstimated: false,
  ageDays: 10,
  width: 800,
  height: 600,
  milestone: null,
  hidden: false,
  thumbUrl: null,
  urlExpiresAt: null,
});

afterEach(cleanup);

function info(takenAt: string | null) {
  render(
    <SharedPhotoViewer
      photos={[photo(takenAt)]}
      startId={ID}
      name="Maya"
      allowDownload={false}
      onClose={() => undefined}
      onLost={() => undefined}
    />,
  );
  const text = screen.getByTestId("share-viewer-info").textContent ?? "";
  cleanup();
  return text;
}

describe("SharedPhotoViewer date", () => {
  it("shows the calendar date as given", () => {
    expect(info("2026-06-14")).toContain("Jun 14, 2026");
  });

  it("does not shift across the date line in any process time zone", () => {
    const tz = process.env.TZ;
    try {
      for (const zone of [
        "Pacific/Kiritimati",
        "Pacific/Pago_Pago",
        "America/Los_Angeles",
        "UTC",
      ]) {
        process.env.TZ = zone;
        expect(info("2026-06-14"), zone).toContain("Jun 14, 2026");
        expect(info("2026-01-01"), zone).toContain("Jan 1, 2026");
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("shows no date for null and for a malformed value", () => {
    expect(info(null)).not.toMatch(/20\d\d/);
    expect(info("not-a-date")).not.toMatch(/20\d\d/);
  });
});
