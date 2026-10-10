import type { ImportSource } from "@littlelight/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConfig, SyncStatus } from "../../platform/native/photoSync";
import { jsonResponse, stubFetch } from "../../testing/native";
import { renderApp } from "../../testing/render";

// Album sync card (docs/plans/step-10.md 2.11): empty state, one status line for every phase and
// error (counts with separators), Sync now, pause/resume, Wi-Fi only, change album, stop with an
// honest confirmation. The sync manager is a fake; the card only reads it and calls it.

const BABY = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const DEVICE = "44444444-4444-4444-8444-444444444444";

const sync = vi.hoisted(() => ({
  status: null as unknown as SyncStatus,
  listeners: new Set<() => void>(),
  runSync: vi.fn(),
  setPaused: vi.fn(),
  setWifiOnly: vi.fn(),
  disable: vi.fn(),
}));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../../platform/native/photoSync", () => ({
  photoSync: sync,
  useSyncStatus: () => sync.status,
  PhotoSyncManager: class {},
}));
vi.mock("../../platform/native/installId", () => ({
  getInstallId: async () => "44444444-4444-4444-8444-444444444444",
}));
vi.mock("./SetupSyncSheet", () => ({
  SetupSyncSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="setup-open" /> : null),
}));
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../../testing/ionMocks");
  return { ...actual, IonModal: m.FakeModal, IonAlert: m.FakeAlert };
});
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => nav.navigate };
});
const babies = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Maya",
    nickname: null,
    role: "admin",
    plan: "plus",
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Theo",
    nickname: "Teddy",
    role: "admin",
    plan: "plus",
  },
];
const auth = vi.hoisted(() => ({ babies: [] as unknown[] }));
vi.mock("../../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({ baby: auth.babies[0], babies: auth.babies, setCurrentBabyId: vi.fn() }),
  useAuth: () => ({ me: null }),
  ME_KEY: ["me"],
}));

import { SyncCard, syncStatusLine } from "./SyncCard";

const CFG: SyncConfig = {
  sourceId: SOURCE,
  babyId: BABY,
  albumId: "ALBUM/L0/040",
  albumTitle: "Maya's first year",
  wifiOnly: true,
  paused: false,
};
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  loaded: true,
  config: CFG,
  phase: "idle",
  progress: null,
  lastError: null,
  lastRunAt: null,
  notice: null,
  ...over,
});
const source = (over: Partial<ImportSource> = {}): ImportSource => ({
  id: SOURCE,
  babyId: BABY,
  userId: "33333333-3333-4333-8333-333333333333",
  userName: "Mom",
  kind: "apple_photos",
  deviceId: DEVICE,
  deviceLabel: "iPhone",
  albumTitle: "Maya's first year",
  wifiOnly: true,
  paused: false,
  isMine: true,
  isThisDevice: true,
  lastSyncAt: "2026-10-10T09:00:00.000Z",
  lastTrigger: "manual",
  importedCount: 1240,
  duplicateCount: 12,
  failedCount: 0,
  skippedCount: 3,
  lastError: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

let row: ImportSource | null = source();

beforeEach(() => {
  auth.babies = [babies[0]];
  sync.status = status();
  sync.runSync.mockReset();
  sync.setPaused.mockReset();
  sync.setWifiOnly.mockReset();
  sync.disable.mockReset();
  nav.navigate.mockReset();
  row = source();
  stubFetch((c) => {
    if (c.url.includes("/me/import-sources")) return jsonResponse({ sources: row ? [row] : [] });
    return jsonResponse({}, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("syncStatusLine", () => {
  it("up to date with a thousands separator once the server row has a sync", () => {
    expect(syncStatusLine(status(), source())).toBe("Up to date · 1,240 imported");
  });

  it("ready / up to date without server counters", () => {
    expect(syncStatusLine(status(), null)).toBe("Ready to sync");
    expect(syncStatusLine(status({ lastRunAt: 1 }), null)).toBe("Up to date");
  });

  it("syncing shows 'Syncing 12 of 50…', or plain 'Syncing…' before the total is known", () => {
    expect(
      syncStatusLine(status({ phase: "syncing", progress: { done: 12, total: 50 } }), null),
    ).toBe("Syncing 12 of 50…");
    expect(
      syncStatusLine(status({ phase: "syncing", progress: { done: 0, total: 0 } }), null),
    ).toBe("Syncing…");
    expect(
      syncStatusLine(status({ phase: "syncing", progress: { done: 1200, total: 2400 } }), null),
    ).toBe("Syncing 1,200 of 2,400…");
  });

  it("waiting for Wi-Fi, low power, paused", () => {
    expect(syncStatusLine(status({ phase: "waiting_wifi" }), null)).toBe("Waiting for Wi-Fi");
    expect(syncStatusLine(status({ phase: "low_power" }), null)).toMatch(/Low Power Mode/);
    expect(syncStatusLine(status({ phase: "paused" }), null)).toBe("Paused");
  });

  it.each([
    ["free_tier_limit", "Free album is full (1,000 photos)"],
    ["permission_denied", "Allow full photo access in Settings"],
    ["album_missing", "That album no longer exists"],
    ["network", "Couldn't reach Littlelight. It will try again later."],
    ["storage_error", "Couldn't store some photos. It will try again later."],
    ["baby_trashed", "This album is in the trash"],
  ] as const)("error %s", (err, line) => {
    expect(syncStatusLine(status({ phase: "error", lastError: err }), null)).toBe(line);
  });

  it("an error from the server row shows when this session has none; signed_out is not shown as an error", () => {
    expect(syncStatusLine(status(), source({ lastError: "album_missing" }))).toBe(
      "That album no longer exists",
    );
    expect(syncStatusLine(status(), source({ lastError: "signed_out" }))).toBe(
      "Up to date · 1,240 imported",
    );
  });
});

describe("SyncCard", () => {
  it("not loaded yet: a skeleton", () => {
    sync.status = status({ loaded: false, config: null });
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-card-loading")).toBeTruthy();
  });

  it("not set up: the empty state and a Set up button that opens the sheet", () => {
    sync.status = status({ config: null, phase: "off" });
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-empty").textContent).toMatch(/Keep an album in sync/);
    fireEvent.click(screen.getByTestId("sync-setup-open"));
    expect(screen.getByTestId("setup-open")).toBeTruthy();
  });

  it("not set up because the server turned it off: tells the user", () => {
    sync.status = status({ config: null, phase: "off", notice: "removed" });
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-removed")).toBeTruthy();
  });

  it("compact: album, status, Sync now and a link to more options; no pause/stop controls", async () => {
    renderApp(<SyncCard compact />);
    expect(screen.getByTestId("sync-album").textContent).toContain("Maya's first year");
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").textContent).toBe("Up to date · 1,240 imported"),
    );
    expect(screen.queryByTestId("sync-pause")).toBeNull();
    expect(screen.queryByTestId("sync-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("sync-manage"));
    expect(nav.navigate).toHaveBeenCalledWith("/settings/import");
    fireEvent.click(screen.getByTestId("sync-now"));
    expect(sync.runSync).toHaveBeenCalledWith("manual");
  });

  it("names the baby only when the parent has several", () => {
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-album").textContent).not.toContain("For ");
    cleanup();
    auth.babies = babies;
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-album").textContent).toContain("For Maya");
  });

  it("while syncing: a progress bar, and Sync now is disabled", () => {
    sync.status = status({ phase: "syncing", progress: { done: 12, total: 50 } });
    renderApp(<SyncCard />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("24");
    expect((screen.getByTestId("sync-now") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("sync-status").textContent).toBe("Syncing 12 of 50…");
  });

  it("an error line is styled as an error and permission_denied explains what to do", () => {
    sync.status = status({ phase: "error", lastError: "permission_denied" });
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-status").className).toContain("text-danger-text");
    expect(screen.getByText(/choose Full Access/)).toBeTruthy();
  });

  it("full card: last sync with counts, Wi-Fi toggle, Pause, Change album", async () => {
    renderApp(<SyncCard />);
    await waitFor(() => expect(screen.getByTestId("sync-last")).toBeTruthy());
    expect(screen.getByTestId("sync-last").textContent).toContain("1,240");
    fireEvent.click(screen.getByTestId("sync-pause"));
    expect(sync.setPaused).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("sync-change"));
    expect(screen.getByTestId("setup-open")).toBeTruthy();
    const wifi = screen.getByTestId("sync-wifi-toggle") as HTMLInputElement;
    fireEvent.click(wifi.querySelector("input") ?? wifi);
    expect(sync.setWifiOnly).toHaveBeenCalledWith(false);
  });

  it("paused: the button says Resume and resumes", () => {
    sync.status = status({ phase: "paused", config: { ...CFG, paused: true } });
    renderApp(<SyncCard />);
    expect(screen.getByTestId("sync-pause").textContent).toBe("Resume");
    fireEvent.click(screen.getByTestId("sync-pause"));
    expect(sync.setPaused).toHaveBeenCalledWith(false);
  });

  it("Stop syncing asks first, says nothing is deleted from Littlelight, and only then disables", () => {
    renderApp(<SyncCard />);
    fireEvent.click(screen.getByTestId("sync-stop"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Stop syncing this album\?/);
    expect(dialog.textContent).toMatch(/Photos already in Littlelight stay where they are/);
    expect(sync.disable).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText("Stop syncing").at(-1) as HTMLElement);
    expect(sync.disable).toHaveBeenCalled();
  });

  it("cancelling the stop confirmation changes nothing", () => {
    renderApp(<SyncCard />);
    fireEvent.click(screen.getByTestId("sync-stop"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(sync.disable).not.toHaveBeenCalled();
  });

  it("works when the server row is unavailable (offline): still shows the album and local state", async () => {
    row = null;
    renderApp(<SyncCard />);
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").textContent).toBe("Ready to sync"),
    );
  });
});
