import { cleanup, render, screen } from "@testing-library/react";
import type { PhotoSummary } from "@tinyglow/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// Timeline tile for a video (docs/plans/step-12.md 2.8): a play glyph + duration badge bottom
// right, readable label, no badge on photos, and a badge without a time while the duration is
// unknown. The image itself is the poster frame (thumb) like any photo.

vi.mock("../PhotoImage", () => ({
  PhotoImage: ({ photo }: { photo: { id: string } }) => (
    <img alt="" data-testid={`img-${photo.id}`} />
  ),
}));

import { DurationBadge, Thumb } from "./Thumb";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photo = (over: Partial<PhotoSummary> = {}): PhotoSummary =>
  ({
    id: ID,
    babyId: "11111111-1111-4111-8111-111111111111",
    status: "ready",
    approval: "approved",
    mediaKind: "photo",
    durationMs: null,
    renditionStatus: "none",
    takenAt: "2026-06-14T10:00:00.000Z",
    takenAtEstimated: false,
    width: 1200,
    height: 900,
    isSensitive: false,
    milestoneId: null,
    aiStatus: "none",
    thumbUrl: null,
    displayUrl: null,
    urlExpiresAt: null,
    ...over,
  }) as PhotoSummary;

const noop = () => undefined;
const view = (p: PhotoSummary) =>
  render(
    <Thumb
      photo={p}
      baby={{ name: "Mia", nickname: null }}
      milestoneName={null}
      timeZone="UTC"
      selectMode={false}
      selected={false}
      pendingActions={false}
      busy={false}
      onOpen={noop}
      onToggle={noop}
      onApprove={noop}
      onReject={noop}
    />,
  );

afterEach(cleanup);

describe("Thumb: video badge", () => {
  it("a video shows the duration badge with a readable label", () => {
    view(photo({ mediaKind: "video", durationMs: 42_000, renditionStatus: "ready" }));
    const badge = screen.getByTestId(`photo-video-${ID}`);
    expect(badge.textContent).toBe("0:42");
    expect(badge.getAttribute("aria-label")).toBe("Video, 0:42");
    expect(screen.getByTestId(`img-${ID}`)).toBeTruthy(); // the poster frame
  });

  it("a photo has no badge", () => {
    view(photo());
    expect(screen.queryByTestId(`photo-video-${ID}`)).toBeNull();
  });

  it("a video without a known duration still gets the glyph, labelled plainly", () => {
    view(photo({ mediaKind: "video", durationMs: null, renditionStatus: "pending" }));
    const badge = screen.getByTestId(`photo-video-${ID}`);
    expect(badge.textContent).toBe("");
    expect(badge.getAttribute("aria-label")).toBe("Video");
  });

  it("a sensitive video shows both the sensitive and the duration badges", () => {
    view(
      photo({
        mediaKind: "video",
        durationMs: 725_000,
        isSensitive: true,
        renditionStatus: "ready",
      }),
    );
    expect(screen.getByTestId(`photo-sensitive-${ID}`)).toBeTruthy();
    expect(screen.getByTestId(`photo-video-${ID}`).textContent).toBe("12:05");
  });

  it("DurationBadge formats hours and never shows a negative or NaN time", () => {
    render(<DurationBadge id="x" durationMs={3_725_000} />);
    expect(screen.getByTestId("photo-video-x").textContent).toBe("1:02:05");
    cleanup();
    render(<DurationBadge id="y" durationMs={-5} />);
    expect(screen.getByTestId("photo-video-y").textContent).toBe("0:00");
  });
});
