import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ImportBatch } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, stubFetch } from "../../testing/native";
import { renderApp } from "../../testing/render";

// The import progress sheet (docs/plans/step-10.md 2.11): one body per batch status, results with
// separators, contributor notice, cancel, retry on failure, the photo lists refresh on completion.

const BABY = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../../testing/ionMocks");
  return { ...actual, IonModal: m.FakeModal, IonAlert: m.FakeAlert };
});
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => nav.navigate };
});

import { GoogleImportSheet } from "./GoogleImportSheet";

const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: BATCH,
  babyId: BABY,
  kind: "google_picker",
  status: "picking",
  error: null,
  requestedBy: USER,
  requestedByName: "Mom",
  isMine: true,
  itemsTotal: null,
  itemsImported: 0,
  itemsDuplicate: 0,
  itemsFailed: 0,
  itemsSkipped: 0,
  pollIntervalSec: 5,
  pickerExpiresAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...over,
});

let current = batch();
const cbs = { close: vi.fn(), again: vi.fn() };

function install() {
  return stubFetch((c) => {
    if (c.url.endsWith(`/imports/${BATCH}/cancel`))
      return jsonResponse({ batch: { ...current, status: "cancelled" } });
    if (c.url.endsWith(`/imports/${BATCH}`)) return jsonResponse({ batch: current });
    return jsonResponse({}, 404);
  });
}
function show(over: Partial<Parameters<typeof GoogleImportSheet>[0]> = {}, client?: QueryClient) {
  return renderApp(
    <GoogleImportSheet
      open
      babyId={BABY}
      batchId={BATCH}
      starting={false}
      startError={null}
      manualPickerUrl={null}
      contributor={false}
      onClose={cbs.close}
      onAgain={cbs.again}
      {...over}
    />,
    { client },
  );
}

beforeEach(() => {
  current = batch();
  cbs.close.mockReset();
  cbs.again.mockReset();
  nav.navigate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GoogleImportSheet states", () => {
  it("closed: renders nothing and does not poll", () => {
    const { fn } = install();
    show({ open: false });
    expect(screen.queryByTestId("google-sheet")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("starting: a loading skeleton labelled 'Opening Google Photos…'", () => {
    install();
    show({ batchId: null, starting: true });
    expect(screen.getByRole("status", { name: /Opening Google Photos/ })).toBeTruthy();
  });

  it("a start error replaces everything with the message", () => {
    install();
    show({ batchId: null, startError: "Connect Google Photos first." });
    expect(screen.getByTestId("google-start-error").textContent).toBe(
      "Connect Google Photos first.",
    );
  });

  it("picking: waits for the user in Google Photos, with Cancel and Hide", async () => {
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe(
        "Choose your photos in Google Photos",
      ),
    );
    expect(screen.getByTestId("google-cancel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("google-hide"));
    expect(cbs.close).toHaveBeenCalled();
  });

  it("someone else's batch (a co-admin looking in) has no Cancel", async () => {
    current = batch({ isMine: false, requestedByName: "Dad" });
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-sheet-state")).toBeTruthy());
    expect(screen.queryByTestId("google-cancel")).toBeNull();
  });

  it("a manual picker link appears while picking only", async () => {
    install();
    show({ manualPickerUrl: "https://photos.google.com/picker/abc" });
    await waitFor(() =>
      expect(screen.getByTestId("google-open-picker").getAttribute("href")).toBe(
        "https://photos.google.com/picker/abc",
      ),
    );
    cleanup();
    current = batch({ status: "running", itemsTotal: 4 });
    show({ manualPickerUrl: "https://photos.google.com/picker/abc" });
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("Importing your photos"),
    );
    expect(screen.queryByTestId("google-open-picker")).toBeNull();
  });

  it("queued: 'Getting ready…'", async () => {
    current = batch({ status: "queued" });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("Getting ready…"),
    );
  });

  it("running: '12 of 23 photos' with a progressbar at the right value", async () => {
    current = batch({
      status: "running",
      itemsTotal: 23,
      itemsImported: 10,
      itemsDuplicate: 1,
      itemsFailed: 1,
    });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-progress-text").textContent).toBe("12 of 23 photos"),
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      String(Math.round((12 / 23) * 100)),
    );
  });

  it("running with a thousand photos formats the counts", async () => {
    current = batch({ status: "running", itemsTotal: 1240, itemsImported: 1000 });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-progress-text").textContent).toBe("1,000 of 1,240 photos"),
    );
  });

  it("done: 20 imported, 2 already here, 1 skipped, 1 failed, and a button to the timeline", async () => {
    current = batch({
      status: "done",
      itemsTotal: 24,
      itemsImported: 20,
      itemsDuplicate: 2,
      itemsSkipped: 1,
      itemsFailed: 1,
    });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("Import finished"),
    );
    expect(screen.getByTestId("google-result-imported").textContent).toContain("20");
    expect(screen.getByTestId("google-result-duplicate").textContent).toContain("2");
    expect(screen.getByTestId("google-result-skipped").textContent).toContain("1");
    expect(screen.getByTestId("google-result-failed").textContent).toContain("1");
    expect(screen.queryByTestId("google-pending-note")).toBeNull();
    fireEvent.click(screen.getByTestId("google-done"));
    expect(cbs.close).toHaveBeenCalled();
    expect(nav.navigate).toHaveBeenCalledWith("/timeline");
  });

  it("done for a contributor: the 'waits for a parent's approval' notice and no timeline jump", async () => {
    current = batch({ status: "done", itemsTotal: 3, itemsImported: 3 });
    install();
    show({ contributor: true });
    await waitFor(() => expect(screen.getByTestId("google-pending-note")).toBeTruthy());
    expect(screen.getByTestId("google-done").textContent).toBe("Done");
    fireEvent.click(screen.getByTestId("google-done"));
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("done with nothing imported says so and offers Done only", async () => {
    current = batch({ status: "done", itemsTotal: 2, itemsDuplicate: 2 });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("Nothing was imported"),
    );
    expect(screen.getByTestId("google-done").textContent).toBe("Done");
  });

  it("failed: a specific reason, the results so far, and Start again", async () => {
    current = batch({
      status: "failed",
      error: "google_reconnect",
      itemsImported: 2,
      itemsFailed: 1,
      itemsTotal: 5,
    });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-batch-error").textContent).toMatch(/connect again/i),
    );
    expect(screen.getByTestId("google-result-imported").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("google-again"));
    expect(cbs.again).toHaveBeenCalled();
  });

  it.each([
    ["google_denied", /didn't allow access/],
    ["session_expired", /timed out/],
    ["storage_error", /store some photos/],
    ["requester_not_member", /no longer a member/],
    ["baby_trashed", /in the trash/],
    ["internal", /on our side/],
  ] as const)("failed with %s", async (error, re) => {
    current = batch({ status: "failed", error });
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-batch-error").textContent).toMatch(re));
  });

  it("expired and cancelled offer Start again", async () => {
    current = batch({ status: "expired" });
    install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("That took too long"),
    );
    expect(screen.getByTestId("google-again")).toBeTruthy();
    cleanup();
    current = batch({ status: "cancelled" });
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("Import cancelled"),
    );
    expect(screen.getByTestId("google-again")).toBeTruthy();
  });

  it("a load failure shows a generic message", async () => {
    stubFetch(() => jsonResponse({ error: "internal", message: "x" }, 500));
    show();
    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy(),
    );
  });
});

describe("GoogleImportSheet actions", () => {
  it("Cancel import POSTs the cancel and shows the cancelled state", async () => {
    const { calls } = install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-cancel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-cancel"));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.endsWith(`/imports/${BATCH}/cancel`)),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe("Import cancelled"),
    );
  });

  it("a failed cancel shows the error and keeps the sheet", async () => {
    stubFetch((c) =>
      c.method === "POST"
        ? jsonResponse({ error: "internal", message: "x" }, 500)
        : jsonResponse({ batch: current }),
    );
    show();
    await waitFor(() => expect(screen.getByTestId("google-cancel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-cancel"));
    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy(),
    );
    expect(screen.getByTestId("google-sheet-state").textContent).toBe(
      "Choose your photos in Google Photos",
    );
  });

  it("a finished import refreshes the photo lists, milestones and the imports list once", async () => {
    current = batch({ status: "done", itemsTotal: 1, itemsImported: 1 });
    install();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    show({}, client);
    await waitFor(() => expect(screen.getByTestId("google-results")).toBeTruthy());
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys.some((k) => k.includes("milestones"))).toBe(true);
    expect(keys.some((k) => k.includes("imports"))).toBe(true);
    const n = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(spy.mock.calls.length).toBe(n);
  });
});
