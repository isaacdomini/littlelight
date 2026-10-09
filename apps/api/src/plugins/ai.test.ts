import { describe, expect, it, vi } from "vitest";
import { createAiServices } from "./ai";

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
const dump = (l: ReturnType<typeof log>) =>
  JSON.stringify([l.info.mock.calls, l.warn.mock.calls, l.error.mock.calls]);

describe("createAiServices", () => {
  it("no key: no chat, no embedder, one boot line naming the env var", () => {
    const l = log();
    const ai = createAiServices({}, l);
    expect(ai.chat).toBeNull();
    expect(ai.embedder).toBeNull();
    expect(ai.chatDisabledReason).toBe("OPENAI_API_KEY not set");
    expect(ai.embedDisabledReason).toBe("OPENAI_API_KEY not set");
    expect(ai.chatReasoningEffort).toBe("low");
    expect(l.info.mock.calls.map((c) => c[1])).toEqual([
      "AI disabled: OPENAI_API_KEY not set; chat unavailable, search runs in keyword mode",
    ]);
  });

  it("an empty key counts as unset (compose passes OPENAI_API_KEY=)", () => {
    expect(createAiServices({ OPENAI_API_KEY: "" }, log()).chat).toBeNull();
  });

  it("the fake provider needs no key and gives a fake chat model and the bag-of-words embedder", () => {
    const l = log();
    const ai = createAiServices({ VISION_PROVIDER: "fake" }, l);
    expect(ai.chat?.provider).toBe("fake");
    expect(ai.embedder?.model).toBe("fake");
    expect(ai.embedder?.dims).toBe(1024);
    expect(l.info.mock.calls.map((c) => c[1])).toContain(
      "AI enabled: provider=fake chat=gpt-6-luna embed=fake/1024",
    );
  });

  it("an OpenAI key gives the real adapters; the key never reaches a log line or the services object", () => {
    const l = log();
    const ai = createAiServices({ OPENAI_API_KEY: "sk-secret-key-123" }, l);
    expect(ai.chat?.provider).toBe("openai");
    expect(ai.embedder?.model).toBe("text-embedding-3-small");
    expect(dump(l)).not.toContain("sk-secret-key-123");
    expect(JSON.stringify(ai)).not.toContain("sk-secret-key-123");
    expect(l.info.mock.calls.map((c) => c[1])).toContain(
      "AI enabled: provider=openai chat=gpt-6-luna embed=text-embedding-3-small/1024",
    );
  });

  it("an Anthropic-only deployment has neither chat (not implemented) nor embeddings", () => {
    const l = log();
    const ai = createAiServices(
      {
        VISION_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        VISION_MODEL: "claude-haiku-5-5",
      },
      l,
    );
    expect(ai.chat).toBeNull();
    expect(ai.embedder).toBeNull();
    expect(ai.chatDisabledReason).toMatch(/not implemented/i);
    expect(dump(l)).not.toContain("sk-ant-secret");
  });

  it("the fake provider is refused in production unless opted in", () => {
    const refused = createAiServices({ VISION_PROVIDER: "fake", NODE_ENV: "production" }, log());
    expect(refused.chat).toBeNull();
    expect(refused.embedder).toBeNull();
    const l = log();
    const ok = createAiServices(
      { VISION_PROVIDER: "fake", NODE_ENV: "production", AI_ALLOW_FAKE_IN_PRODUCTION: "true" },
      l,
    );
    expect(ok.chat).not.toBeNull();
    expect(l.warn.mock.calls.length).toBeGreaterThan(0);
  });

  it("an invalid AI config never throws: services are null and the reason names fields only", () => {
    const l = log();
    const ai = createAiServices({ VISION_PROVIDER: "gemini", OPENAI_API_KEY: "sk-leak" }, l);
    expect(ai.chat).toBeNull();
    expect(ai.embedder).toBeNull();
    expect(dump(l)).not.toMatch(/sk-leak|gemini/);
    const bad = createAiServices({ OPENAI_API_KEY: "sk-x", CHAT_MODEL: "gpt-9" }, l);
    expect(bad.chat).toBeNull();
    expect(bad.chatDisabledReason).toMatch(/CHAT_MODEL/);
    // the embedder survives a bad chat model
    expect(bad.embedder).not.toBeNull();
    expect(dump(l)).not.toContain("gpt-9");
  });

  it("an unpriced EMBED_MODEL disables only the embedder", () => {
    const ai = createAiServices({ OPENAI_API_KEY: "sk-x", EMBED_MODEL: "embed-9" }, log());
    expect(ai.embedder).toBeNull();
    expect(ai.embedDisabledReason).toMatch(/EMBED_MODEL/);
    expect(ai.chat).not.toBeNull();
  });

  it("CHAT_REASONING_EFFORT is surfaced, with a fallback on invalid config", () => {
    expect(
      createAiServices({ OPENAI_API_KEY: "k", CHAT_REASONING_EFFORT: "medium" }, log())
        .chatReasoningEffort,
    ).toBe("medium");
    expect(createAiServices({ VISION_PROVIDER: "gemini" }, log()).chatReasoningEffort).toBe("low");
  });
});
