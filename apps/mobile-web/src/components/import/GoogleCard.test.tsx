import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ImportBatch } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { renderApp } from "../../testing/render";

// Google Photos card (docs/plans/step-10.md 2.11, D14, D15): hidden when the server has the
// feature off, connect/reconnect, import start, recent imports, disconnect with confirmation,
// contributor notice, native uses the system browser.

const BABY = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({ role: "admin" as string, navigate: vi.fn() }));
const browser = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  addListener: vi.fn(async () => ({ remove: vi.fn() })),
}));
vi.mock("@capacitor/browser", () => ({ Browser: browser }));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../../testing/ionMocks");
  return { ...actual, IonModal: m.FakeModal, IonAlert: m.FakeAlert };
});
vi.mock("../../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Maya",
      nickname: null,
      role: state.role,
      plan: "plus",
    },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  useAuth: () => ({ me: null }),
  ME_KEY: ["me"],
}));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => state.navigate };
});

import { GoogleCard } from "./GoogleCard";

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

let conn = {
  available: true,
  connected: false,
  connectedAt: null as string | null,
  needsReconnect: false,
};
let recent: ImportBatch[] = [];
let createRes: () => Response = () =>
  jsonResponse({ batch: batch(), pickerUri: "https://photos.google.com/picker/abc" }, 201);
let connectRes: () => Response = () =>
  jsonResponse({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });

function install() {
  return stubFetch((c) => {
    const path = new URL(c.url, "http://x").pathname.replace(/^\/api/, "");
    if (path === "/me/import/google/connection" && c.method === "GET") return jsonResponse(conn);
    if (path === "/me/import/google/connection" && c.method === "DELETE")
      return jsonResponse(null, 204);
    if (path === "/me/import/google/connect") return connectRes();
    if (path === `/babies/${BABY}/imports` && c.method === "GET")
      return jsonResponse({ batches: recent });
    if (path === `/babies/${BABY}/imports/google` && c.method === "POST") return createRes();
    if (path === `/imports/${BATCH}`) return jsonResponse({ batch: recent[0] ?? batch() });
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
}

beforeEach(() => {
  state.role = "admin";
  state.navigate.mockReset();
  browser.open.mockClear();
  conn = { available: true, connected: false, connectedAt: null, needsReconnect: false };
  recent = [];
  createRes = () =>
    jsonResponse({ batch: batch(), pickerUri: "https://photos.google.com/picker/abc" }, 201);
  connectRes = () => jsonResponse({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setNativePlatform(null);
});

const show = (props: { compact?: boolean } = {}) =>
  renderApp(<GoogleCard returnTo="/upload" {...props} />, { route: "/upload" });
const fakeTab = () =>
  ({
    closed: false,
    location: { href: "about:blank" },
    close: vi.fn(),
    opener: {},
  }) as unknown as Window & { location: { href: string } };

describe("availability", () => {
  it("renders nothing when the server has Google import off", async () => {
    conn = { ...conn, available: false };
    install();
    const r = show();
    await waitFor(() => expect(screen.queryByTestId("google-card-loading")).toBeNull());
    expect(r.container.querySelector("[data-testid=google-card]")).toBeNull();
  });

  it("shows a skeleton while loading and an error line when the check fails", async () => {
    stubFetch(() => jsonResponse({ error: "internal", message: "x" }, 500));
    show();
    await waitFor(() => expect(screen.getByTestId("google-check-error")).toBeTruthy());
  });
});

describe("not connected", () => {
  it("explains, says Google removes locations, and offers Connect Google Photos", async () => {
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-connect")).toBeTruthy());
    expect(screen.getByTestId("google-connect").textContent).toBe("Connect Google Photos");
    expect(screen.getByTestId("google-intro")).toBeTruthy();
    expect(screen.getByTestId("google-location-note").textContent).toMatch(/removes locations/i);
    expect(screen.queryByTestId("google-import")).toBeNull();
    expect(screen.queryByTestId("google-contributor-note")).toBeNull();
  });

  it("web: the tab is opened from the click, the consent URL is loaded into it, a waiting note appears", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab);
    const { calls } = install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-connect")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-connect"));
    await waitFor(() =>
      expect(tab.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
    );
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(calls.find((c) => c.url.endsWith("/me/import/google/connect"))?.body).toEqual({
      client: "web",
      returnTo: "/upload",
    });
    expect(screen.getByTestId("google-connect-wait").textContent).toMatch(/Waiting for Google/);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("a blocked popup leaves a link the user can tap", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-connect")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-connect"));
    await waitFor(() =>
      expect(screen.getByTestId("google-connect-link").getAttribute("href")).toMatch(
        /^https:\/\/accounts\.google\.com/,
      ),
    );
    expect(screen.getByTestId("google-connect-link").getAttribute("rel")).toContain("noopener");
  });

  it("native: opens the system browser, never the WebView or a popup, and tells the server it is native", async () => {
    setNativePlatform("ios");
    const open = vi.spyOn(window, "open");
    const { calls } = install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-connect")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-connect"));
    await waitFor(() =>
      expect(browser.open).toHaveBeenCalledWith({
        url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
        presentationStyle: "popover",
      }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(calls.find((c) => c.url.endsWith("/me/import/google/connect"))?.body).toMatchObject({
      client: "native",
    });
  });

  it("a failed connect request shows a friendly error and closes the pre-opened tab", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab);
    connectRes = () => jsonResponse({ error: "rate_limited", message: "x" }, 429);
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-connect")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-connect"));
    await waitFor(() =>
      expect(screen.getByTestId("google-connect-error").textContent).toMatch(/Too many tries/),
    );
    expect(tab.close).toHaveBeenCalled();
  });

  it("needs a reconnect: says so and offers Reconnect Google Photos instead of import", async () => {
    conn = {
      available: true,
      connected: true,
      connectedAt: "2026-10-01T10:00:00.000Z",
      needsReconnect: true,
    };
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-reconnect-note")).toBeTruthy());
    expect(screen.getByTestId("google-connect").textContent).toBe("Reconnect Google Photos");
    expect(screen.queryByTestId("google-import")).toBeNull();
  });
});

describe("connected", () => {
  beforeEach(() => {
    conn = {
      available: true,
      connected: true,
      connectedAt: "2026-10-09T10:00:00.000Z",
      needsReconnect: false,
    };
  });

  it("offers Import from Google Photos; compact links to the full controls and hides disconnect", async () => {
    install();
    show({ compact: true });
    await waitFor(() => expect(screen.getByTestId("google-import")).toBeTruthy());
    expect(screen.getByTestId("google-import").textContent).toBe("Import from Google Photos");
    expect(screen.queryByTestId("google-disconnect")).toBeNull();
    fireEvent.click(screen.getByTestId("google-manage"));
    expect(state.navigate).toHaveBeenCalledWith("/settings/import");
  });

  it("a contributor sees the 'waits for a parent's approval' notice", async () => {
    state.role = "contributor";
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-contributor-note")).toBeTruthy());
    expect(screen.getByTestId("google-import")).toBeTruthy();
  });

  it("a viewer-less role (no import rights) gets no import button", async () => {
    state.role = "viewer";
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-card")).toBeTruthy());
    expect(screen.queryByTestId("google-import")).toBeNull();
    expect(screen.queryByTestId("google-connect")).toBeNull();
  });

  it("starting an import: POST with an empty body, picker opened in the pre-opened tab, the sheet shows progress", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab);
    const { calls } = install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-import"));
    await waitFor(() => expect(tab.location.href).toBe("https://photos.google.com/picker/abc"));
    expect(
      calls.find((c) => c.method === "POST" && c.url.endsWith("/imports/google"))?.body,
    ).toEqual({});
    await waitFor(() =>
      expect(screen.getByTestId("google-sheet-state").textContent).toBe(
        "Choose your photos in Google Photos",
      ),
    );
    expect(screen.getByTestId("google-cancel")).toBeTruthy();
  });

  it("native: the picker opens in the system browser", async () => {
    setNativePlatform("ios");
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-import"));
    await waitFor(() =>
      expect(browser.open).toHaveBeenCalledWith({
        url: "https://photos.google.com/picker/abc",
        presentationStyle: "popover",
      }),
    );
  });

  it("a blocked picker tab leaves an 'Open Google Photos' link in the sheet (the URL is kept in memory only)", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-import"));
    await waitFor(() =>
      expect(screen.getByTestId("google-open-picker").getAttribute("href")).toBe(
        "https://photos.google.com/picker/abc",
      ),
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("an import already running is shown instead of starting another", async () => {
    recent = [batch({ status: "running", itemsTotal: 10, itemsImported: 3 })];
    const { calls } = install();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("google-import").textContent).toBe("Show import progress"),
    );
    expect(screen.getByTestId("google-active")).toBeTruthy();
    fireEvent.click(screen.getByTestId("google-import"));
    await waitFor(() => expect(screen.getByTestId("google-sheet")).toBeTruthy());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/imports/google"))).toBe(false);
  });

  it("start errors are explained in the sheet (import_in_progress with nothing running falls back to the message)", async () => {
    createRes = () => jsonResponse({ error: "google_reconnect", message: "x" }, 409);
    vi.spyOn(window, "open").mockReturnValue(fakeTab());
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-import"));
    await waitFor(() =>
      expect(screen.getByTestId("google-start-error").textContent).toMatch(/connect again/i),
    );
  });

  it("the full card lists recent imports with status chips, the requester for others' imports, and counts", async () => {
    recent = [
      batch({
        id: "a1111111-1111-4111-8111-111111111111",
        status: "done",
        itemsImported: 1180,
        itemsDuplicate: 41,
        itemsTotal: 1221,
        finishedAt: "2026-10-10T10:05:00.000Z",
      }),
      batch({
        id: "a2222222-2222-4222-8222-222222222222",
        status: "failed",
        error: "internal",
        isMine: false,
        requestedByName: "Dad",
        itemsFailed: 2,
      }),
    ];
    install();
    show();
    await waitFor(() => expect(screen.getAllByTestId("google-recent-row")).toHaveLength(2));
    const rows = screen.getAllByTestId("google-recent-row");
    expect(rows[0]?.textContent).toContain("1,180 imported");
    expect(rows[0]?.textContent).toContain("41 already here");
    expect(rows[0]?.textContent).toContain("Done");
    expect(rows[1]?.textContent).toContain("by Dad");
    expect(rows[1]?.textContent).toContain("Failed");
  });

  it("an empty history says so", async () => {
    install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-recent-empty")).toBeTruthy());
  });

  it("Disconnect asks first (nothing is deleted from the album), then calls DELETE and flips the card to not connected", async () => {
    const { calls } = install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-disconnect")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-disconnect"));
    expect(screen.getByRole("alertdialog").textContent).toContain("Disconnect Google Photos?");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    conn = { ...conn, connected: false, connectedAt: null };
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/me/import/google/connection")),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("google-connect")).toBeTruthy());
  });

  it("cancelling the confirmation does nothing", async () => {
    const { calls } = install();
    show();
    await waitFor(() => expect(screen.getByTestId("google-disconnect")).toBeTruthy());
    fireEvent.click(screen.getByTestId("google-disconnect"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
