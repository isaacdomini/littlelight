import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, setNativePlatform, stubFetch } from "../../testing/native";
import { ionReady, renderApp } from "../../testing/render";

// Chat history is a data right (docs/plans/review-fixes.md 2.7, D15): an admin of a downgraded
// (free) album can still read and clear it, but cannot send. Nobody else can see it.

const BABY = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ role: "admin", plan: "free" }));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ me: { babies: [], profile: { timezone: "UTC" } } }),
  useCurrentBaby: () => ({
    baby: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Maya",
      nickname: null,
      role: state.role,
      plan: state.plan,
    },
    babies: [],
    setCurrentBabyId: vi.fn(),
  }),
  ME_KEY: ["me"],
}));

import { ChatPanel } from "./ChatPanel";

const MSG = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "user",
  text: "when did she first smile",
  photos: [],
  citations: { photoIds: [], measurementIds: [] },
  grounded: false,
  status: "complete",
  createdAt: "2026-10-01T10:00:00.000Z",
};
const THREAD = {
  threadId: "33333333-3333-4333-8333-333333333333",
  messages: [MSG],
  turnsLeftToday: 0,
};
const EMPTY = { threadId: null, messages: [], turnsLeftToday: 0 };

let thread: unknown = THREAD;

beforeEach(() => {
  state.role = "admin";
  state.plan = "free";
  thread = THREAD;
  setNativePlatform(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function install() {
  return stubFetch((c) => {
    if (c.url.endsWith(`/babies/${BABY}/chat/thread`) && c.method === "GET")
      return jsonResponse(thread);
    if (c.url.endsWith(`/babies/${BABY}/chat/thread`) && c.method === "DELETE") {
      thread = EMPTY;
      return jsonResponse(null, 204);
    }
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
}

async function open() {
  const r = renderApp(<ChatPanel variant="page" />, { route: "/chat" });
  await ionReady(r.container);
  return r;
}

describe("ChatPanel on a free album", () => {
  it("an admin with history sees the upsell AND a Clear chat history button; sending is not offered", async () => {
    install();
    await open();
    expect(screen.getByTestId("chat-upsell")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("chat-clear-free")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the thread is loaded for the free admin (the history route has no plan gate)", async () => {
    const { calls } = install();
    await open();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && c.url.includes("/chat/thread"))).toBe(true),
    );
  });

  it("no button when there is no history", async () => {
    thread = EMPTY;
    const { calls } = install();
    await open();
    await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
    expect(screen.queryByTestId("chat-clear-free")).toBeNull();
  });

  it("confirming sends DELETE and the button goes away", async () => {
    const { calls } = install();
    await open();
    fireEvent.click(await screen.findByTestId("chat-clear-free"));
    const alert = await waitFor(() => {
      const el = document.querySelector("ion-alert");
      if (!el) throw new Error("alert not open");
      return el as HTMLElement & { buttons: { text: string; handler?: () => void }[] };
    });
    await waitFor(() => expect(alert.buttons?.length).toBeGreaterThan(0));
    alert.buttons.find((b) => b.handler)?.handler?.();
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("chat-clear-free")).toBeNull());
  });

  it("native free album: the app-store-safe notice with the clear button, no purchase link", async () => {
    setNativePlatform("ios");
    install();
    await open();
    expect(screen.getByTestId("chat-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("chat-upsell-link")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("chat-clear-free")).toBeTruthy());
  });
});

describe("ChatPanel for a contributor", () => {
  it("never requests the thread and offers no clear button", async () => {
    state.role = "contributor";
    const { calls } = install();
    await open();
    expect(calls.filter((c) => c.url.includes("/chat/thread"))).toEqual([]);
    expect(screen.queryByTestId("chat-clear-free")).toBeNull();
  });
});
