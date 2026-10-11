import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";

// FreeTierNotice (docs/plans/step-11.md 2.8, 2.9): family usage for parents and guests, the
// near-full warning, the over-cap line, and no purchase prompt in the native apps.

const q = vi.hoisted(() => ({
  data: null as null | { used: number; limit: number; familyAlbums: number },
  useFreeTier: vi.fn(),
}));
vi.mock("../lib/queries/freeTier", () => ({
  useFreeTier: (...a: unknown[]) => {
    q.useFreeTier(...a);
    return { data: q.data };
  },
}));

import { FreeTierNotice } from "./FreeTierNotice";

const baby = (role: "admin" | "contributor", plan: "free" | "plus" = "free") => ({
  id: "11111111-1111-4111-8111-111111111111",
  plan,
  role,
});
const pool = (used: number, familyAlbums = 1) => ({ used, limit: 1000, familyAlbums });
const text = () => screen.getByTestId("free-tier-notice").textContent ?? "";
const tone = () => screen.getByTestId("free-tier-notice").getAttribute("data-tone");

beforeEach(() => {
  setNativePlatform(null);
  q.useFreeTier.mockReset();
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

describe("usage line", () => {
  it("parent: your family's free photos, one album", () => {
    q.data = pool(120, 1);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(text()).toBe("Your family's free photos: 120 of 1,000 (1 album)");
    expect(tone()).toBe("ok");
  });

  it("parent: across N albums when the family has several", () => {
    q.data = pool(120, 3);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(text()).toBe("Your family's free photos: 120 of 1,000 (across 3 albums)");
  });

  it("guest (contributor): this family's free photos, no album count", () => {
    q.data = pool(120, 3);
    render(<FreeTierNotice baby={baby("contributor")} />);
    expect(text()).toBe("This family's free photos: 120 of 1,000");
    expect(text()).not.toMatch(/Your family|album/);
  });

  it("renders nothing without data (Plus, trashed or loading)", () => {
    q.data = null;
    const { container } = render(<FreeTierNotice baby={baby("admin", "plus")} />);
    expect(container.textContent).toBe("");
    // the hook is told not to fetch for a Plus album
    expect(q.useFreeTier).toHaveBeenCalledWith(baby("admin").id, false);
  });

  it("asks the hook to fetch for a free album", () => {
    q.data = pool(1);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(q.useFreeTier).toHaveBeenCalledWith(baby("admin").id, true);
  });
});

describe("near full", () => {
  it("parent on the web: warning with the upgrade hint", () => {
    q.data = pool(940, 2);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(tone()).toBe("near");
    expect(screen.getByTestId("free-tier-near").textContent).toMatch(
      /Almost full: 60 free photos left/,
    );
    expect(screen.getByTestId("free-tier-near").textContent).toMatch(/Upgrade to Plus/);
  });

  it("guest: warning without any upgrade talk", () => {
    q.data = pool(940);
    render(<FreeTierNotice baby={baby("contributor")} />);
    expect(tone()).toBe("near");
    expect(screen.getByTestId("free-tier-near").textContent).not.toMatch(/upgrade|plus/i);
  });

  it("starts at 900 and not before", () => {
    q.data = pool(899);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(tone()).toBe("ok");
    expect(screen.queryByTestId("free-tier-near")).toBeNull();
    cleanup();
    q.data = pool(900);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(tone()).toBe("near");
  });
});

describe("over the cap", () => {
  it("parent on the web: albums are full, upgrade or delete", () => {
    q.data = pool(1000, 2);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(tone()).toBe("over");
    expect(text()).toBe(
      "Your family's free albums are full (1,000 of 1,000). Upgrade to Plus or delete photos to add more.",
    );
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("guest: this family's albums are full, ask a parent", () => {
    q.data = pool(1000);
    render(<FreeTierNotice baby={baby("contributor")} />);
    expect(text()).toBe(
      "This family's free albums are full (1,000 of 1,000). Ask a parent to make room.",
    );
  });

  it("a grandfathered family above 1,000 still reads as full with its real count", () => {
    q.data = pool(1012);
    render(<FreeTierNotice baby={baby("contributor")} />);
    expect(tone()).toBe("over");
    expect(text()).toContain("1,012 of 1,000");
  });
});

describe("native apps never prompt to buy Plus", () => {
  for (const platform of ["ios", "android"] as const) {
    for (const role of ["admin", "contributor"] as const) {
      for (const used of [10, 950, 1000]) {
        it(`${platform} ${role} at ${used}: no upgrade or Plus wording`, () => {
          setNativePlatform(platform);
          q.data = pool(used, 2);
          render(<FreeTierNotice baby={baby(role)} />);
          const all = screen.getByTestId("free-tier-notice").textContent ?? "";
          expect(all).not.toMatch(/upgrade|plus|subscribe|buy/i);
        });
      }
    }
  }

  it("native over-cap still says the albums are full", () => {
    setNativePlatform("ios");
    q.data = pool(1000, 2);
    render(<FreeTierNotice baby={baby("admin")} />);
    expect(text()).toMatch(/free albums are full/i);
    expect(text()).toMatch(/delete photos/i);
  });
});
