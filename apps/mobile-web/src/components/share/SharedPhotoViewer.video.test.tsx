import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ViewerPhoto } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The share viewer's video slide (docs/plans/step-12.md 2.8, Q9): a <video> fed by the `web` URL
// from `/share/photos/urls` (kind web, video ids only), the poster from `display`, the download
// button saving the MP4 rendition when the link allows it, and nothing for a photo slide.

const api = vi.hoisted(() => ({
  fetchShareUrls: vi.fn(),
  fetchShareDownload: vi.fn(),
}));
vi.mock("../../lib/shareApi", () => api);
vi.mock("swiper/react", () => ({
  Swiper: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  SwiperSlide: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("swiper/modules", () => ({ Keyboard: {}, Virtual: {}, Zoom: {} }));
vi.mock("swiper/css", () => ({}));
vi.mock("swiper/css/virtual", () => ({}));
vi.mock("swiper/css/zoom", () => ({}));

import { SharedPhotoViewer } from "./SharedPhotoViewer";

const VID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = (id: string, over: Partial<ViewerPhoto> = {}): ViewerPhoto => ({
  id,
  mediaKind: "photo",
  durationMs: null,
  takenAt: "2026-06-14",
  takenAtEstimated: false,
  ageDays: 100,
  width: 1080,
  height: 1920,
  milestone: null,
  hidden: false,
  thumbUrl: "https://files.test/thumb.jpg",
  urlExpiresAt: null,
  ...over,
});
const video = base(VID, { mediaKind: "video", durationMs: 42_000 });
const pic = base(PIC);
const far = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  api.fetchShareUrls.mockReset().mockImplementation(async (ids: string[], kind: string) => ({
    urls: ids
      .filter((id) => kind !== "web" || id === VID)
      .map((id) => ({
        id,
        url: `https://files.test/${id}/${kind}.${kind === "web" ? "mp4" : "jpg"}?sig=1`,
        expiresAt: far,
      })),
  }));
  api.fetchShareDownload
    .mockReset()
    .mockResolvedValue({ url: `https://files.test/${VID}/web.mp4?dl=1&sig=2`, expiresAt: far });
});
afterEach(cleanup);

function open(startId: string, allowDownload = false) {
  return render(
    <SharedPhotoViewer
      photos={[video, pic]}
      startId={startId}
      name="Maya"
      allowDownload={allowDownload}
      onClose={() => undefined}
      onLost={() => undefined}
    />,
  );
}

describe("SharedPhotoViewer: videos", () => {
  it("asks for display URLs and a web URL for the video slide only, then renders a <video> with the rendition", async () => {
    open(VID);
    await waitFor(() => expect(screen.getByTestId(`share-video-player-${VID}`)).toBeTruthy());
    const player = screen.getByTestId(`share-video-player-${VID}`) as HTMLVideoElement;
    await waitFor(() => expect(player.getAttribute("src")).toMatch(/web\.mp4/));
    expect(player.getAttribute("src")).not.toMatch(/originals/);
    expect(player.getAttribute("poster")).toMatch(/display\.jpg/);
    expect(player.hasAttribute("controls")).toBe(true);
    expect(player.hasAttribute("playsinline") || player.getAttribute("playsinline") !== null).toBe(
      true,
    );
    const webCalls = api.fetchShareUrls.mock.calls.filter((c) => c[1] === "web");
    expect(webCalls.length).toBeGreaterThan(0);
    for (const c of webCalls) expect(c[0]).toEqual([VID]);
    // the info line is age + date for videos too (the duration badge lives on the tile)
    expect(screen.getByTestId("share-viewer-info").textContent).toMatch(/Jun 14, 2026/);
  });

  it("a photo slide has no player", async () => {
    open(PIC);
    await waitFor(() => expect(api.fetchShareUrls).toHaveBeenCalled());
    expect(screen.queryByTestId(`share-video-player-${PIC}`)).toBeNull();
  });

  it("download is hidden when the link forbids it, and saves the MP4 rendition URL when allowed", async () => {
    open(VID, false);
    await waitFor(() => expect(api.fetchShareUrls).toHaveBeenCalled());
    expect(screen.queryByTestId("share-download")).toBeNull();
    cleanup();
    open(VID, true);
    const button = await screen.findByTestId("share-download");
    const assign = vi.fn();
    const anchor = document.createElement("a");
    const clickSpy = vi.spyOn(anchor, "click").mockImplementation(() => undefined);
    const create = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tag: string) =>
        tag === "a"
          ? anchor
          : document.createElementNS("http://www.w3.org/1999/xhtml", tag)) as never);
    try {
      fireEvent.click(button);
      await waitFor(() => expect(api.fetchShareDownload).toHaveBeenCalledWith(VID));
      await waitFor(() =>
        expect(clickSpy.mock.calls.length + assign.mock.calls.length).toBeGreaterThan(0),
      );
      expect(anchor.getAttribute("href") ?? "").toMatch(/web\.mp4/);
    } finally {
      create.mockRestore();
      clickSpy.mockRestore();
    }
  });

  it("a playback error re-requests the web URL instead of showing the original", async () => {
    open(VID);
    const player = await screen.findByTestId(`share-video-player-${VID}`);
    await waitFor(() => expect(player.getAttribute("src")).toMatch(/web\.mp4/));
    const before = api.fetchShareUrls.mock.calls.filter((c) => c[1] === "web").length;
    fireEvent.error(player);
    await waitFor(() =>
      expect(api.fetchShareUrls.mock.calls.filter((c) => c[1] === "web").length).toBeGreaterThan(
        before,
      ),
    );
    expect(JSON.stringify(api.fetchShareUrls.mock.calls)).not.toContain("originals");
  });
});
