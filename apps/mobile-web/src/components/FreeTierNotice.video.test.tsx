import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";

// The usage line with videos (docs/plans/step-12.md Q3, 2.8, 2.11): "({v} of 100 videos)" when the
// server sends `videos`/`videoLimit`, a "videos full" line at the cap (no Plus wording on native),
// and the old shape (no video fields) still renders.

const q = vi.hoisted(() => ({
  data: null as null | Record<string, number>,
}));
vi.mock("../lib/queries/freeTier", () => ({
  useFreeTier: () => ({ data: q.data }),
}));

import { FreeTierNotice } from "./FreeTierNotice";

const baby = (role: "admin" | "contributor") => ({
  id: "11111111-1111-4111-8111-111111111111",
  plan: "free" as const,
  role,
});
const text = () => screen.getByTestId("free-tier-notice").textContent ?? "";

beforeEach(() => setNativePlatform(null));
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

describe("FreeTierNotice: videos", () => {
  it("parent: the usage line carries the video count out of 100", () => {
    q.data = { used: 120, limit: 1000, familyAlbums: 1, videos: 7, videoLimit: 100 };
    render(<FreeTierNotice baby={baby("admin") as never} />);
    expect(text()).toContain("120 of 1,000");
    expect(text()).toContain("7 of 100 videos");
    expect(screen.getByTestId("free-tier-notice").getAttribute("data-videos")).toBe("7");
    expect(screen.queryByTestId("free-tier-videos-full")).toBeNull();
  });

  it("at 100 videos: the videos-full line (web mentions Plus, native never)", () => {
    q.data = { used: 300, limit: 1000, familyAlbums: 2, videos: 100, videoLimit: 100 };
    render(<FreeTierNotice baby={baby("admin") as never} />);
    const full = screen.getByTestId("free-tier-videos-full");
    expect(full.textContent).toMatch(/100 videos/);
    expect(full.textContent).toMatch(/Plus|upgrade/i);
    cleanup();
    setNativePlatform("ios");
    render(<FreeTierNotice baby={baby("admin") as never} />);
    expect(screen.getByTestId("free-tier-videos-full").textContent).not.toMatch(
      /Plus|upgrade|buy/i,
    );
  });

  it("guest at the video cap: told to ask a parent, no upgrade talk", () => {
    q.data = { used: 300, limit: 1000, familyAlbums: 1, videos: 100, videoLimit: 100 };
    render(<FreeTierNotice baby={baby("contributor") as never} />);
    const full = screen.getByTestId("free-tier-videos-full");
    expect(full.textContent).not.toMatch(/Plus|upgrade/i);
  });

  it("an older server without the video fields still renders the plain usage line", () => {
    q.data = { used: 12, limit: 1000, familyAlbums: 1 };
    render(<FreeTierNotice baby={baby("admin") as never} />);
    expect(text()).toContain("12 of 1,000");
    expect(text()).not.toMatch(/videos/);
    expect(screen.getByTestId("free-tier-notice").getAttribute("data-videos")).toBeNull();
  });

  it("over the 1,000 cap the over line wins (no second videos line)", () => {
    q.data = { used: 1000, limit: 1000, familyAlbums: 1, videos: 100, videoLimit: 100 };
    render(<FreeTierNotice baby={baby("admin") as never} />);
    expect(screen.getByTestId("free-tier-notice").getAttribute("data-tone")).toBe("over");
    expect(screen.queryByTestId("free-tier-videos-full")).toBeNull();
  });
});
