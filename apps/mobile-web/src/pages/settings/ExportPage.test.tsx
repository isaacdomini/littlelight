import type { DataExport } from "@littlelight/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Settings -> Export your data (docs/plans/review-fixes.md R.11, D1-D6): admins only, location
// toggle on by default, progress, download only for the requester, fresh sign-in retry.

const BABY = "11111111-1111-4111-8111-111111111111";
const ME = "33333333-3333-4333-8333-333333333333";
const E1 = "22222222-2222-4222-8222-222222222221";
const E2 = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({ role: "admin" as string }));
const fresh = vi.hoisted(() => ({ withFresh: vi.fn(async (fn: () => Promise<unknown>) => fn()) }));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: { babies: [] } }),
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Maya",
      role: state.role,
      plan: "free",
    },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  ME_KEY: ["me"],
}));
vi.mock("../../auth/FreshSignInGate", () => ({ useFreshSignIn: () => fresh.withFresh }));

import { ExportPage } from "./ExportPage";

const row = (over: Partial<DataExport> = {}): DataExport => ({
  id: E1,
  babyId: BABY,
  status: "ready",
  includeLocation: true,
  requestedBy: ME,
  requestedByName: "Mom",
  isMine: true,
  photoCount: 12,
  photosDone: 12,
  bytes: 5_242_880,
  error: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  startedAt: "2026-10-10T10:00:05.000Z",
  finishedAt: "2026-10-10T10:01:00.000Z",
  expiresAt: "2026-10-17T10:00:00.000Z",
  canDownload: true,
  ...over,
});

let exportsNow: DataExport[] = [];
let respondExtra: (url: string, method: string) => Response | null = () => null;

function install() {
  return stubFetch((c) => {
    const extra = respondExtra(c.url, c.method);
    if (extra) return extra;
    if (c.method === "GET" && c.url.endsWith(`/babies/${BABY}/exports`)) {
      return jsonResponse({ exports: exportsNow });
    }
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
}

beforeEach(() => {
  state.role = "admin";
  exportsNow = [];
  respondExtra = () => null;
  fresh.withFresh.mockClear();
  setNativePlatform(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  const r = renderApp(<ExportPage />, { route: "/settings/export" });
  await ionReady(r.container);
  return r;
}

describe("ExportPage access", () => {
  it("shows only a forbidden notice to a contributor and makes no export request", async () => {
    state.role = "contributor";
    const { calls } = install();
    await open();
    expect(screen.getByText("Only album admins can export data.")).toBeTruthy();
    expect(screen.queryByTestId("export-request")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/exports"))).toEqual([]);
  });
});

describe("ExportPage list", () => {
  it("empty state when there are no exports", async () => {
    install();
    await open();
    await waitFor(() => expect(screen.getByTestId("export-empty")).toBeTruthy());
  });

  it("a ready export of mine offers Download; another admin's does not and says why", async () => {
    exportsNow = [
      row(),
      row({
        id: E2,
        isMine: false,
        canDownload: false,
        requestedBy: "44444444-4444-4444-8444-444444444444",
        requestedByName: "Dad",
      }),
    ];
    install();
    await open();
    await waitFor(() => expect(screen.getAllByTestId("export-ready")).toHaveLength(2));
    const [mine, other] = screen.getAllByTestId("export-ready");
    expect(mine?.querySelector('[data-testid="export-download"]')).toBeTruthy();
    expect(other?.querySelector('[data-testid="export-download"]')).toBeNull();
    expect(other?.textContent).toContain("Only the person who requested it can download it.");
    expect(other?.textContent).toContain("Requested by Dad");
    expect(mine?.textContent).toContain("5.0 MB");
  });

  it("a deleted requester reads as a former member", async () => {
    exportsNow = [
      row({ isMine: false, canDownload: false, requestedBy: null, requestedByName: null }),
    ];
    install();
    await open();
    await waitFor(() => expect(screen.getByTestId("export-ready")).toBeTruthy());
    expect(screen.getByTestId("export-ready").textContent).toContain("a former member");
  });

  it("running export shows progress and disables a new request", async () => {
    exportsNow = [
      row({ status: "running", photosDone: 3, photoCount: 12, canDownload: false, bytes: null }),
    ];
    install();
    await open();
    await waitFor(() => expect(screen.getByTestId("export-progress")).toBeTruthy());
    expect(screen.getByTestId("export-progress").textContent).toContain("3 of 12 photos");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect((screen.getByTestId("export-request") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed export shows a friendly reason, never the raw code or a URL", async () => {
    exportsNow = [row({ status: "failed", error: "too_large", canDownload: false, bytes: null })];
    install();
    await open();
    // the row and its reason paragraph both carry the test id
    await waitFor(() => expect(screen.getAllByTestId("export-failed").length).toBeGreaterThan(0));
    const reason = document.querySelector("p[data-testid='export-failed']");
    const text = reason?.textContent ?? "";
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain("too_large");
    expect(document.body.textContent).not.toMatch(/https?:|\.zip/);
  });
});

describe("ExportPage request", () => {
  it("location is on by default and the request carries it; a fresh sign-in wrapper is used", async () => {
    const { calls } = install();
    respondExtra = (url, method) =>
      method === "POST" && url.endsWith(`/babies/${BABY}/exports`)
        ? jsonResponse({ export: row({ status: "queued", canDownload: false, bytes: null }) }, 202)
        : null;
    await open();
    const box = (await screen.findByTestId("export-location")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByTestId("export-request"));
    await waitFor(() => expect(screen.getByTestId("export-notice")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ includeLocation: true });
    expect(fresh.withFresh).toHaveBeenCalled();
  });

  it("unchecking location sends includeLocation false", async () => {
    const { calls } = install();
    respondExtra = (url, method) =>
      method === "POST" && url.endsWith("/exports")
        ? jsonResponse({ export: row({ status: "queued", canDownload: false, bytes: null }) }, 202)
        : null;
    await open();
    const box = (await screen.findByTestId("export-location")) as HTMLInputElement;
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId("export-request"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ includeLocation: false });
  });

  it.each([
    ["export_in_progress", 409, "An export is already being prepared. Wait for it to finish."],
    ["rate_limited", 429, "You've requested the maximum for today. Try again tomorrow."],
    ["baby_trashed", 409, "This album is in the trash and can't be exported."],
  ])("maps %s to a friendly message", async (code, status, text) => {
    install();
    respondExtra = (url, method) =>
      method === "POST" && url.endsWith("/exports")
        ? jsonResponse({ error: code, message: "server words" }, status)
        : null;
    await open();
    await screen.findByTestId("export-request");
    fireEvent.click(screen.getByTestId("export-request"));
    await waitFor(() => expect(screen.getByTestId("export-error").textContent).toBe(text));
  });
});

describe("ExportPage download", () => {
  const SIGNED = `https://storage.example.test/littlelight/babies/${BABY}/exports/${E1}.zip?X-Amz-Signature=abc`;

  it("web: mints a URL after a fresh sign-in and clicks a hidden anchor; the URL is never shown", async () => {
    exportsNow = [row()];
    install();
    respondExtra = (url, method) =>
      method === "POST" && url.endsWith(`/exports/${E1}/download-url`)
        ? jsonResponse({ url: SIGNED, expiresAt: "2026-10-10T10:10:00.000Z" })
        : null;
    const clicks: { href: string; download: string }[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    };
    try {
      await open();
      const btn = await screen.findByTestId("export-download");
      fireEvent.click(btn);
      await waitFor(() => expect(clicks).toHaveLength(1));
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    expect(clicks[0]?.href).toBe(SIGNED);
    expect(clicks[0]?.download).toBe("littlelight-export-2026-10-10.zip");
    expect(document.body.textContent).not.toContain("X-Amz-Signature");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(fresh.withFresh).toHaveBeenCalled();
  });

  it("a 403 not_requester or a 410 shows its message and refreshes the list", async () => {
    exportsNow = [row()];
    const { calls } = install();
    respondExtra = (url, method) =>
      method === "POST" && url.endsWith("/download-url")
        ? jsonResponse({ error: "export_expired", message: "gone" }, 410)
        : null;
    await open();
    fireEvent.click(await screen.findByTestId("export-download"));
    await waitFor(() =>
      expect(screen.getByTestId("export-error").textContent).toBe(
        "This export has expired. Request a new one.",
      ),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.endsWith("/exports")).length,
      ).toBeGreaterThan(1),
    );
  });
});

describe("ExportPage delete", () => {
  it("asks first; cancel sends nothing, confirm sends DELETE", async () => {
    exportsNow = [row()];
    const { calls } = install();
    respondExtra = (url, method) =>
      method === "DELETE" && url.endsWith(`/exports/${E1}`) ? jsonResponse(null, 204) : null;
    const confirm = vi.spyOn(window, "confirm");
    await open();
    const del = await screen.findByTestId("export-delete");
    confirm.mockReturnValueOnce(false);
    fireEvent.click(del);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(del);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

void ApiError;
