import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, stubFetch } from "../../testing/native";
import { renderApp } from "../../testing/render";

// Set up album sync sheet (docs/plans/step-10.md 2.11): looking never prompts, "Allow access to
// Photos" is the one place the system prompt appears, limited/denied explain what to do, albums
// are chosen from a list, the baby is chosen when a parent has several, Wi-Fi only defaults on,
// errors from the server are explained.

const sync = vi.hoisted(() => ({
  authorization: vi.fn(),
  requestAuthorization: vi.fn(),
  albums: vi.fn(),
  enable: vi.fn(),
}));
vi.mock("../../platform/native/photoSync", () => ({ photoSync: sync }));
vi.mock("@ionic/react", async () => {
  const actual = await vi.importActual<typeof import("@ionic/react")>("@ionic/react");
  const m = await import("../../testing/ionMocks");
  return { ...actual, IonModal: m.FakeModal };
});
const auth = vi.hoisted(() => ({
  babies: [] as { id: string; name: string; nickname: string | null; role: string }[],
}));
vi.mock("../../auth/AuthProvider", () => ({
  useCurrentBaby: () => ({ baby: auth.babies[0], babies: auth.babies, setCurrentBabyId: vi.fn() }),
  useAuth: () => ({ me: null }),
  ME_KEY: ["me"],
}));

import { SetupSyncSheet } from "./SetupSyncSheet";

const MAYA = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Maya",
  nickname: null,
  role: "admin",
};
const THEO = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Theo",
  nickname: "Teddy",
  role: "admin",
};
const NANNY_BABY = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Cousin",
  nickname: null,
  role: "contributor",
};
const ALBUMS = [
  { id: "A/L0/040", title: "Maya's first year", count: 1240 },
  { id: "B/L0/040", title: "Holidays", count: 36 },
];
const onClose = vi.fn();

function show() {
  return renderApp(<SetupSyncSheet open onClose={onClose} />);
}

beforeEach(() => {
  auth.babies = [MAYA];
  sync.authorization.mockReset().mockResolvedValue("authorized");
  sync.requestAuthorization.mockReset().mockResolvedValue("authorized");
  sync.albums.mockReset().mockResolvedValue(ALBUMS);
  sync.enable.mockReset().mockResolvedValue({ ok: true });
  onClose.mockReset();
  stubFetch(() => jsonResponse({ sources: [] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("access step", () => {
  it("checking the status never shows the system prompt", async () => {
    sync.authorization.mockResolvedValue("notDetermined");
    show();
    await waitFor(() => expect(screen.getByTestId("sync-allow")).toBeTruthy());
    expect(sync.requestAuthorization).not.toHaveBeenCalled();
    expect(sync.albums).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-setup-explain").textContent).toMatch(/full access|photos/i);
  });

  it("'Allow access to Photos' is the button that prompts, then lists the albums", async () => {
    sync.authorization.mockResolvedValue("notDetermined");
    show();
    await waitFor(() =>
      expect(screen.getByTestId("sync-allow").textContent).toBe("Allow access to Photos"),
    );
    fireEvent.click(screen.getByTestId("sync-allow"));
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    expect(sync.requestAuthorization).toHaveBeenCalledTimes(1);
  });

  it("limited access explains it is not enough and lets the user re-check", async () => {
    sync.authorization.mockResolvedValue("limited");
    show();
    await waitFor(() => expect(screen.getByTestId("sync-recheck")).toBeTruthy());
    expect(screen.getByTestId("sync-setup-explain").textContent).toMatch(/limited|all photos/i);
    expect(screen.queryByTestId("sync-allow")).toBeNull();
    sync.authorization.mockResolvedValue("authorized");
    fireEvent.click(screen.getByTestId("sync-recheck"));
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    expect(sync.requestAuthorization).not.toHaveBeenCalled();
  });

  it.each(["denied", "restricted"])(
    "%s explains how to turn it on in Settings, without a prompt",
    async (s) => {
      sync.authorization.mockResolvedValue(s);
      show();
      await waitFor(() => expect(screen.getByTestId("sync-recheck")).toBeTruthy());
      expect(screen.getByTestId("sync-setup-explain").textContent).toMatch(/Settings/);
      expect(sync.requestAuthorization).not.toHaveBeenCalled();
    },
  );
});

describe("album, baby and start", () => {
  it("lists albums with counts (thousands separator); Start needs an album", async () => {
    show();
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    expect(screen.getByTestId("sync-albums").textContent).toContain("1,240 photos");
    expect((screen.getByTestId("sync-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("radio")[0] as HTMLElement);
    expect((screen.getByTestId("sync-start") as HTMLButtonElement).disabled).toBe(false);
  });

  it("no albums: says to create one in Photos", async () => {
    sync.albums.mockResolvedValue([]);
    show();
    await waitFor(() => expect(screen.getByText(/No albums found/)).toBeTruthy());
  });

  it("starts with the chosen album, the current baby and Wi-Fi only on by default; closes on success", async () => {
    show();
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("radio")[1] as HTMLElement);
    fireEvent.click(screen.getByTestId("sync-start"));
    await waitFor(() =>
      expect(sync.enable).toHaveBeenCalledWith({
        babyId: MAYA.id,
        albumId: "B/L0/040",
        albumTitle: "Holidays",
        wifiOnly: true,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("the Wi-Fi checkbox is respected", async () => {
    show();
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    const box = screen.getByTestId("sync-wifi") as HTMLInputElement;
    fireEvent.click(box.querySelector("input") ?? box);
    fireEvent.click(screen.getAllByRole("radio")[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("sync-start"));
    await waitFor(() =>
      expect(sync.enable).toHaveBeenCalledWith(expect.objectContaining({ wifiOnly: false })),
    );
  });

  it("a parent of several babies picks one (admin babies only)", async () => {
    auth.babies = [MAYA, THEO, NANNY_BABY];
    show();
    await waitFor(() => expect(screen.getByTestId("sync-baby")).toBeTruthy());
    const select =
      screen.getByTestId("sync-baby").querySelector("select") ??
      (screen.getByTestId("sync-baby") as HTMLSelectElement);
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      "Maya",
      "Teddy",
    ]);
    fireEvent.change(select, { target: { value: THEO.id } });
    fireEvent.click(screen.getAllByRole("radio")[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("sync-start"));
    await waitFor(() =>
      expect(sync.enable).toHaveBeenCalledWith(expect.objectContaining({ babyId: THEO.id })),
    );
  });

  it("one baby: no baby picker", async () => {
    show();
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    expect(screen.queryByTestId("sync-baby")).toBeNull();
  });

  it.each([
    ["permission", /full access/],
    ["exists", /Another account/],
    ["limit", /most synced albums/],
    ["forbidden", /parents can turn on/],
    ["trashed", /in the trash/],
    ["network", /Couldn't reach/],
  ])("a server refusal (%s) is explained and the sheet stays open", async (reason, re) => {
    sync.enable.mockResolvedValue({ ok: false, reason });
    show();
    await waitFor(() => expect(screen.getByTestId("sync-albums")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("radio")[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("sync-start"));
    await waitFor(() => expect(screen.getByTestId("sync-setup-error").textContent).toMatch(re));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancel closes without enabling anything", async () => {
    show();
    await waitFor(() => expect(screen.getByTestId("sync-setup-cancel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-setup-cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(sync.enable).not.toHaveBeenCalled();
  });

  it("closed: renders nothing and asks for nothing", () => {
    renderApp(<SetupSyncSheet open={false} onClose={onClose} />);
    expect(screen.queryByTestId("sync-setup")).toBeNull();
    expect(sync.authorization).not.toHaveBeenCalled();
  });
});
