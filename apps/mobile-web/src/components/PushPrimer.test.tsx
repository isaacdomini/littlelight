import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "../testing/native";
import { renderApp } from "../testing/render";

// The one-time offer to turn on notifications after the first completed upload (docs/plans/
// step-9.md 2.8, 2.15): opt-in only, never prompts until the user taps, answered once.

const auth = vi.hoisted(() => ({
  me: { babies: [] as { id: string; role: string; plan: string }[] },
}));
const push = vi.hoisted(() => ({ pushPermission: vi.fn(), enablePush: vi.fn() }));
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me }),
  useCurrentBaby: () => ({ baby: null, babies: [], setCurrentBabyId: vi.fn() }),
  ME_KEY: ["me"],
}));
vi.mock("../platform/native/push", () => push);

import { PushPrimer } from "./PushPrimer";

const admin = { id: "b1", role: "admin", plan: "plus" };
const ANSWERED = "ll_push_primer_answered";

beforeEach(() => {
  auth.me = { babies: [admin] };
  push.pushPermission.mockReset().mockResolvedValue("prompt");
  push.enablePush.mockReset().mockResolvedValue("enabled");
  window.localStorage.clear();
  setNativePlatform("ios");
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

const shown = () => screen.queryByTestId("push-primer");

describe("PushPrimer eligibility", () => {
  it("is offered after an upload finished when permission has not been decided", async () => {
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
    expect(push.enablePush).not.toHaveBeenCalled(); // nothing asked yet
  });

  it("is never shown on the web", async () => {
    setNativePlatform(null);
    renderApp(<PushPrimer uploaded />);
    await new Promise((r) => setTimeout(r, 30));
    expect(shown()).toBeNull();
    expect(push.pushPermission).not.toHaveBeenCalled();
  });

  it("waits for a completed upload", async () => {
    renderApp(<PushPrimer uploaded={false} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(shown()).toBeNull();
    expect(push.pushPermission).not.toHaveBeenCalled();
  });

  it.each(["granted", "denied", "unavailable"])(
    "is not shown when the OS permission is %s",
    async (perm) => {
      push.pushPermission.mockResolvedValue(perm);
      renderApp(<PushPrimer uploaded />);
      await waitFor(() => expect(push.pushPermission).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(shown()).toBeNull();
    },
  );

  it("is not shown to someone who is only a contributor (contributors never get push)", async () => {
    auth.me = { babies: [{ id: "b2", role: "contributor", plan: "plus" }] };
    renderApp(<PushPrimer uploaded />);
    await new Promise((r) => setTimeout(r, 30));
    expect(shown()).toBeNull();
    expect(push.pushPermission).not.toHaveBeenCalled();
  });

  it("is shown to a free-tier admin (share-viewed pushes are not an AI feature)", async () => {
    auth.me = { babies: [{ id: "b3", role: "admin", plan: "free" }] };
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
  });

  it("is not shown again once it was answered", async () => {
    window.localStorage.setItem(ANSWERED, "1");
    renderApp(<PushPrimer uploaded />);
    await new Promise((r) => setTimeout(r, 30));
    expect(shown()).toBeNull();
    expect(push.pushPermission).not.toHaveBeenCalled();
  });

  it("never nags when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    renderApp(<PushPrimer uploaded />);
    await new Promise((r) => setTimeout(r, 30));
    expect(shown()).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("PushPrimer actions", () => {
  it("Turn on notifications asks the OS via enablePush, remembers the answer and hides", async () => {
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("push-primer-enable"));
    await waitFor(() => expect(push.enablePush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(shown()).toBeNull());
    expect(window.localStorage.getItem(ANSWERED)).toBe("1");
  });

  it("is answered even when enabling fails", async () => {
    push.enablePush.mockResolvedValue("failed");
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("push-primer-enable"));
    await waitFor(() => expect(shown()).toBeNull());
    expect(window.localStorage.getItem(ANSWERED)).toBe("1");
  });

  it("Not now hides it without ever calling enablePush", async () => {
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("push-primer-later"));
    expect(shown()).toBeNull();
    expect(push.enablePush).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ANSWERED)).toBe("1");
  });

  it("the only thing stored is that the offer was answered", async () => {
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
    fireEvent.click(screen.getByTestId("push-primer-later"));
    expect(Object.keys(window.localStorage)).toEqual([ANSWERED]);
  });

  it("states what the notifications are, without names", async () => {
    renderApp(<PushPrimer uploaded />);
    await waitFor(() => expect(shown()).toBeTruthy());
    expect(shown()?.textContent).toContain("heads-up");
  });
});
