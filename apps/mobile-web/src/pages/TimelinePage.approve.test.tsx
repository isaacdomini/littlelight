import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { setNativePlatform } from "../testing/native";
import { renderApp } from "../testing/render";

// Approving a guest's photo into a full family (docs/plans/step-11.md 2.8, 2.9): the 409
// free_tier_limit from the server becomes a message on the timeline instead of being swallowed.
// Everything around the grid is stubbed; the real page logic (onApprove -> approveError ->
// action-error) is what runs.

const approve = vi.hoisted(() => ({ fn: vi.fn() }));
const PHOTO = { id: "p1", isSensitive: false };

vi.mock("../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Mia",
      nickname: null,
      role: "admin",
      plan: "free",
    },
  }),
}));
vi.mock("../auth/guards", () => ({ useRouteActive: () => true }));
vi.mock("../components/AppHeader", () => ({ AppHeader: () => null }));
vi.mock("../components/chat/ChatPanel", () => ({ ChatPanel: () => null }));
vi.mock("../components/search/FilterChips", () => ({ FilterChips: () => null }));
vi.mock("../components/search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../components/search/SearchResults", () => ({ SearchResults: () => null }));
vi.mock("../components/share/AddToShareSheet", () => ({ AddToShareSheet: () => null }));
vi.mock("../components/timeline/BatchDetailsSheet", () => ({ BatchDetailsSheet: () => null }));
vi.mock("../components/timeline/Scrubber", () => ({ Scrubber: () => null }));
vi.mock("../components/viewer/PhotoViewer", () => ({
  PhotoViewer: () => null,
  ViewerEmpty: () => null,
}));
vi.mock("../components/viewer/useViewerParam", () => ({
  useViewerParam: () => ({
    params: new URLSearchParams(),
    photoId: null,
    change: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock("../components/layout/Panes", () => ({
  useBreakpoint: () => "phone",
  useOnline: () => true,
  Panes: ({ grid }: { grid: ReactNode }) => <div>{grid}</div>,
}));
vi.mock("../components/timeline/TimelineGrid", () => ({
  TimelineGrid: ({ onApprove }: { onApprove: (id: string) => void }) => (
    <button type="button" data-testid="approve-btn" onClick={() => onApprove("p1")}>
      approve
    </button>
  ),
}));
vi.mock("../lib/queries/milestones", () => ({ useMilestones: () => ({ data: [] }) }));
vi.mock("../lib/queries/search", () => ({
  EMPTY_SEARCH: { q: "" },
  hasSearch: () => false,
  useSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useSearchFacets: () => ({ data: undefined }),
}));
vi.mock("../lib/units", () => ({ useProfileTimeZone: () => "UTC" }));
vi.mock("../lib/upload/manager", () => ({ uploadManager: { add: vi.fn() } }));
vi.mock("../lib/queries/photos", () => ({
  flattenTimeline: () => [PHOTO],
  photosRoot: (id: string) => ["babies", id, "photos"],
  usePhotosInvalidation: () => undefined,
  useApprovePhoto: () => ({ mutateAsync: approve.fn, isPending: false, variables: null }),
  useRejectPhoto: () => ({ mutateAsync: vi.fn(), isPending: false, variables: null }),
  useBatchDetails: () => ({ mutateAsync: vi.fn() }),
  useTimeline: () => ({
    data: { pages: [{ photos: [PHOTO], pendingCount: 1 }], pageParams: [] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    hasPreviousPage: false,
    isFetchingNextPage: false,
    isFetchingPreviousPage: false,
    fetchNextPage: vi.fn(),
    fetchPreviousPage: vi.fn(),
  }),
  useTimelineSummary: () => ({ data: undefined }),
}));

import { TimelinePage } from "./TimelinePage";

beforeEach(() => {
  approve.fn.mockReset();
  setNativePlatform(null);
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

describe("approve into a full family", () => {
  it("web: a 409 free_tier_limit shows the family-full message (make room or upgrade)", async () => {
    approve.fn.mockRejectedValue(new ApiError(409, "free_tier_limit", "server text"));
    renderApp(<TimelinePage />, { route: "/timeline" });
    expect(screen.queryByTestId("action-error")).toBeNull();
    fireEvent.click(screen.getByTestId("approve-btn"));
    await waitFor(() => expect(screen.getByTestId("action-error")).toBeTruthy());
    const msg = screen.getByTestId("action-error").textContent ?? "";
    expect(msg).toMatch(/family's free albums are full/i);
    expect(msg).toMatch(/upgrade to Plus/i);
    expect(msg).not.toBe("server text");
  });

  it("native: the same refusal without any purchase wording", async () => {
    setNativePlatform("ios");
    approve.fn.mockRejectedValue(new ApiError(409, "free_tier_limit", "server text"));
    renderApp(<TimelinePage />, { route: "/timeline" });
    fireEvent.click(screen.getByTestId("approve-btn"));
    await waitFor(() => expect(screen.getByTestId("action-error")).toBeTruthy());
    const msg = screen.getByTestId("action-error").textContent ?? "";
    expect(msg).toMatch(/family's free albums are full/i);
    expect(msg).not.toMatch(/upgrade|plus/i);
  });

  it("another failure shows the server's message", async () => {
    approve.fn.mockRejectedValue(new ApiError(409, "conflict", "Already approved"));
    renderApp(<TimelinePage />, { route: "/timeline" });
    fireEvent.click(screen.getByTestId("approve-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("action-error").textContent).toBe("Already approved"),
    );
  });

  it("success shows no error", async () => {
    approve.fn.mockResolvedValue({ id: "p1" });
    renderApp(<TimelinePage />, { route: "/timeline" });
    fireEvent.click(screen.getByTestId("approve-btn"));
    await waitFor(() => expect(approve.fn).toHaveBeenCalledWith("p1"));
    expect(screen.queryByTestId("action-error")).toBeNull();
  });
});
