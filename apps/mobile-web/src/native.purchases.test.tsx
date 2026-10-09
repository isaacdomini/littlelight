import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNativePlatform } from "./testing/native";
import { ionReady, renderApp } from "./testing/render";

// Apple 3.1.1 / Google Play billing safety (docs/plans/step-9.md 2.7, 2.15): Plus is bought on the
// web only, so the app shows no upgrade prompt, price, plan step or Plus mention anywhere. Every
// place that has a web upsell is asserted twice: the web still shows it, the app does not.

const state = vi.hoisted(() => ({
  baby: { id: "b1", name: "Mia", nickname: null, role: "admin", plan: "free" } as {
    id: string;
    name: string;
    nickname: string | null;
    role: string;
    plan: string;
  } | null,
  usage: { data: undefined as unknown, isError: false },
  preview: {
    data: { blockingBabies: [], babiesKept: [], freshSignIn: true } as unknown,
    isError: false,
    error: null,
  },
}));

vi.mock("./auth/AuthProvider", () => ({
  useAuth: () => ({
    me: { profile: { units: "metric", timezone: "UTC" }, babies: [] },
    clearSession: vi.fn(),
  }),
  useCurrentBaby: () => ({
    baby: state.baby,
    babies: state.baby ? [state.baby] : [],
    setCurrentBabyId: vi.fn(),
  }),
  ME_KEY: ["me"],
}));
vi.mock("./auth/FreshSignInGate", () => ({
  useFreshSignIn: () => async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./lib/queries/ai", () => ({ useAiUsage: () => state.usage }));
vi.mock("./lib/queries/search", () => ({ useSearchFacets: () => ({ data: { tags: [] } }) }));
vi.mock("./lib/queries/account", () => ({
  DELETION_PREVIEW_KEY: ["deletion-preview"],
  useDeletionPreview: () => state.preview,
}));
vi.mock("./lib/queries/chat", () => ({
  useChatThread: () => ({ data: undefined, isPending: false }),
  useSendChat: () => ({ turn: null, send: vi.fn(), streaming: false }),
  useClearChat: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./components/viewer/useViewerParam", () => ({
  useViewerParam: () => ({ photoId: null, change: vi.fn(), open: vi.fn() }),
}));

import { AiUsage } from "./components/AiUsage";
import { ChatPanel } from "./components/chat/ChatPanel";
import { SearchBar } from "./components/search/SearchBar";
import { RuleEditor } from "./components/share/RuleEditor";
import { DetailsPanel } from "./components/viewer/DetailsPanel";
import { PlanPage } from "./pages/onboarding/PlanPage";
import { AccountPage } from "./pages/settings/AccountPage";

beforeEach(() => {
  state.baby = { id: "b1", name: "Mia", nickname: null, role: "admin", plan: "free" };
  state.usage = { data: undefined, isError: false };
  state.preview = {
    data: { blockingBabies: [], babiesKept: [], freshSignIn: true },
    isError: false,
    error: null,
  };
});
afterEach(() => {
  cleanup();
  setNativePlatform(null);
});

const NO_PURCHASE_WORDS = /upgrade|plus|\$\d|per month|subscribe|price/i;

describe("AiUsage", () => {
  it("web, free baby: shows the 'part of Plus' line", () => {
    setNativePlatform(null);
    renderApp(<AiUsage babyId="b1" paid={false} />);
    expect(screen.getByTestId("ai-usage").textContent).toContain("Plus");
  });

  it("app, free baby: renders nothing at all", () => {
    setNativePlatform("ios");
    const { container } = renderApp(<AiUsage babyId="b1" paid={false} />);
    expect(screen.queryByTestId("ai-usage-section")).toBeNull();
    expect(container.textContent).not.toMatch(/Plus/);
  });

  it("app, paid baby: the usage section stays", () => {
    setNativePlatform("ios");
    renderApp(<AiUsage babyId="b1" paid />);
    expect(screen.getByTestId("ai-usage-section")).toBeTruthy();
  });
});

describe("SearchBar", () => {
  it("web, disabled: the Plus hint is shown", () => {
    setNativePlatform(null);
    renderApp(<SearchBar value="" onChange={vi.fn()} disabled />);
    expect(screen.getByTestId("search-upsell")).toBeTruthy();
  });

  it("app, disabled: no hint, the input is just disabled", () => {
    setNativePlatform("android");
    renderApp(<SearchBar value="" onChange={vi.fn()} disabled />);
    expect(screen.queryByTestId("search-upsell")).toBeNull();
    expect((screen.getByTestId("search-input") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("share RuleEditor", () => {
  const draft = { mode: "manual" as const, includeTags: [], excludeTags: [] };
  it("web, free baby: the auto-share upsell", () => {
    setNativePlatform(null);
    renderApp(<RuleEditor babyId="b1" plus={false} value={draft} onChange={vi.fn()} />);
    expect(screen.getByTestId("share-rule-upsell")).toBeTruthy();
  });

  it("app, free baby: nothing is rendered", () => {
    setNativePlatform("ios");
    const { container } = renderApp(
      <RuleEditor babyId="b1" plus={false} value={draft} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId("share-rule-upsell")).toBeNull();
    expect(container.textContent).not.toMatch(/Plus/);
  });

  it("app, Plus baby: the rule picker is there", () => {
    setNativePlatform("ios");
    renderApp(<RuleEditor babyId="b1" plus value={draft} onChange={vi.fn()} />);
    expect(screen.getByTestId("share-rule-mode-all")).toBeTruthy();
  });
});

describe("ChatPanel", () => {
  it("web, free admin: the upsell with its link", async () => {
    setNativePlatform(null);
    const { container } = renderApp(<ChatPanel variant="page" />);
    await ionReady(container);
    expect(screen.getByTestId("chat-upsell")).toBeTruthy();
    expect(screen.getByTestId("chat-upsell-link")).toBeTruthy();
  });

  it("app, free admin: a neutral 'not available' note, no upsell, no link, no price", async () => {
    setNativePlatform("ios");
    const { container } = renderApp(<ChatPanel variant="page" />);
    await ionReady(container);
    expect(screen.queryByTestId("chat-upsell")).toBeNull();
    expect(screen.queryByTestId("chat-upsell-link")).toBeNull();
    const note = screen.getByTestId("chat-unavailable");
    expect(note.textContent).toBe("Chat isn't available for this album.");
    expect(note.textContent).not.toMatch(NO_PURCHASE_WORDS);
    expect(container.querySelector('a[href="/settings"]')).toBeNull();
  });

  it("app, contributor: the contributor notice as before (no purchase words)", async () => {
    setNativePlatform("ios");
    state.baby = { id: "b1", name: "Mia", nickname: null, role: "contributor", plan: "free" };
    const { container } = renderApp(<ChatPanel variant="page" />);
    await ionReady(container);
    expect(screen.getByTestId("chat-contributor-notice")).toBeTruthy();
    expect(screen.queryByTestId("chat-upsell")).toBeNull();
  });
});

describe("DetailsPanel (AI caption slot of a free baby)", () => {
  const photo = {
    id: "p1",
    ageDays: 10,
    takenAt: null,
    takenAtEstimated: false,
    isSensitive: false,
    details: null,
    measurements: [],
    exif: null,
    ai: { status: "not_available", description: null, overrides: {} },
  } as never;

  it("web: 'AI descriptions are part of Plus' with an upgrade link", () => {
    setNativePlatform(null);
    renderApp(<DetailsPanel photo={photo} milestones={[]} isAdmin paid={false} />);
    expect(screen.getByTestId("details-ai-upgrade")).toBeTruthy();
  });

  it("app: a neutral line and no link to the settings/billing", () => {
    setNativePlatform("ios");
    const { container } = renderApp(
      <DetailsPanel photo={photo} milestones={[]} isAdmin paid={false} />,
    );
    expect(screen.queryByTestId("details-ai-upgrade")).toBeNull();
    const note = screen.getByTestId("details-ai-unavailable-native");
    expect(note.textContent).toBe("AI descriptions aren't available for this album.");
    expect(container.querySelector('a[href="/settings"]')).toBeNull();
  });
});

describe("PlanPage", () => {
  it("web: shows both plans and the Plus price", async () => {
    setNativePlatform(null);
    const { container } = renderApp(<PlanPage />, { route: "/onboarding/plan" });
    await ionReady(container);
    expect(screen.getByTestId("plan-skip")).toBeTruthy();
    expect(container.textContent).toMatch(/\$3\.99/);
  });

  it("app: the plan step is skipped straight to the first upload (no prices, no upgrade)", async () => {
    setNativePlatform("ios");
    const r = renderApp(<PlanPage />, { route: "/onboarding/plan" });
    await waitFor(() => expect(r.location()).toBe("/onboarding/first-upload"));
    expect(screen.queryByTestId("plan-skip")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });
});

describe("AccountPage deletion consequences", () => {
  async function reachConsequences() {
    const r = renderApp(<AccountPage />, { route: "/settings/account" });
    await ionReady(r.container);
    fireEvent.click(await screen.findByTestId("account-continue"));
    await screen.findByTestId("account-ack");
    return r;
  }

  it("web lists the Plus-goes-back-to-Free line", async () => {
    setNativePlatform(null);
    const { container } = await reachConsequences();
    expect(container.textContent).toContain(
      "If you pay for Plus on an album, it goes back to Free.",
    );
  });

  it.each(["ios", "android"] as const)(
    "%s omits the Plus line (consequence3) and keeps the other three",
    async (platform) => {
      setNativePlatform(platform);
      const { container } = await reachConsequences();
      expect(container.textContent).not.toContain("Plus");
      expect(container.textContent).toContain(
        "Your profile, sign-ins and devices are removed right away.",
      );
      expect(container.textContent).toContain("This can't be undone.");
      expect(container.querySelectorAll("ul.list-disc li")).toHaveLength(3);
    },
  );
});
