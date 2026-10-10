import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The Upload screen lists the user's lane only: album-sync items never show up or count there
// (docs/plans/step-10.md 2.5).

const BABY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("./manager", async () => {
  const actual = await vi.importActual<typeof import("./manager")>("./manager");
  return {
    ...actual,
    uploadManager: { subscribe: () => () => undefined, getSnapshot: () => state.items },
  };
});

import { useUploadItems } from "./useUploads";

const item = (over: Record<string, unknown>) => ({
  clientId: String(Math.random()),
  lane: "user",
  babyId: BABY,
  name: "a.jpg",
  size: 1,
  state: "queued",
  progress: 0,
  error: null,
  retryable: false,
  ...over,
});

describe("useUploadItems", () => {
  it("returns this baby's user-lane items and summarises only those", () => {
    state.items = [
      item({ state: "ingested" }),
      item({ lane: "sync", state: "ingested" }),
      item({ lane: "sync", state: "failed" }),
      item({ babyId: OTHER }),
      item({ state: "failed" }),
    ];
    const { result } = renderHook(() => useUploadItems(BABY));
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items.every((i) => i.lane === "user")).toBe(true);
    expect(result.current.summary).toMatchObject({ total: 2, uploaded: 1, failed: 1 });
  });

  it("no baby, no items", () => {
    state.items = [item({})];
    expect(renderHook(() => useUploadItems(undefined)).result.current.items).toEqual([]);
  });
});
