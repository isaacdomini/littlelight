import { describe, expect, it } from "vitest";
import {
  AiConfigError,
  AiNotConfiguredError,
  AiNotImplementedError,
  createChatModel,
  createEmbedder,
  createVisionDescriber,
  getAiStatus,
  isAiConfigured,
} from "./index";

describe("isAiConfigured", () => {
  it("is false with no key (free tier / unconfigured deployment)", () => {
    expect(isAiConfigured({})).toBe(false);
  });

  it("treats an empty key as unset", () => {
    expect(isAiConfigured({ OPENAI_API_KEY: "" })).toBe(false);
  });

  it("is true with an OpenAI key", () => {
    expect(isAiConfigured({ OPENAI_API_KEY: "x" })).toBe(true);
  });

  it("requires the key of the selected provider", () => {
    expect(isAiConfigured({ VISION_PROVIDER: "anthropic", OPENAI_API_KEY: "x" })).toBe(false);
    expect(isAiConfigured({ VISION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x" })).toBe(true);
  });

  it("is false (never throws) for an invalid provider", () => {
    expect(isAiConfigured({ VISION_PROVIDER: "gemini", OPENAI_API_KEY: "x" })).toBe(false);
  });
});

describe("getAiStatus", () => {
  it("reports defaults and never includes the key", () => {
    const status = getAiStatus({ OPENAI_API_KEY: "sk-secret-value" });
    expect(status).toMatchObject({
      configured: true,
      provider: "openai",
      visionModel: "gpt-6-luna",
      chatModel: "gpt-6-luna",
      embedModel: "text-embedding-3-small",
    });
    expect(JSON.stringify(status)).not.toContain("sk-secret-value");
  });

  it("names the missing env var when disabled", () => {
    expect(getAiStatus({})).toEqual({ configured: false, reason: "OPENAI_API_KEY not set" });
  });
});

const factories = [
  ["createVisionDescriber", createVisionDescriber],
  ["createChatModel", createChatModel],
  ["createEmbedder", createEmbedder],
] as const;

describe("real adapters (step 6)", () => {
  it("createVisionDescriber returns an OpenAI adapter with a key", () => {
    const d = createVisionDescriber({ OPENAI_API_KEY: "x" });
    expect(d.provider).toBe("openai");
    expect(d.model).toBe("gpt-6-luna");
  });

  it("createEmbedder returns an adapter with a key", () => {
    expect(createEmbedder({ OPENAI_API_KEY: "x" }).dims).toBe(1024);
  });

  it("only createChatModel is still not implemented (step 7)", () => {
    expect(() => createChatModel({ OPENAI_API_KEY: "x" })).toThrow(AiNotImplementedError);
    expect(() => createChatModel({ OPENAI_API_KEY: "x" })).toThrow(AiNotConfiguredError);
  });
});

describe.each(factories)("%s", (_name, factory) => {
  it("throws AiNotConfiguredError without a key", () => {
    expect(() => factory({})).toThrow(AiNotConfiguredError);
  });

  it("throws AiConfigError for a bad provider, without echoing the value", () => {
    expect(() => factory({ VISION_PROVIDER: "gemini", OPENAI_API_KEY: "x" })).toThrow(
      AiConfigError,
    );
    try {
      factory({ VISION_PROVIDER: "gemini", OPENAI_API_KEY: "sk-leak" });
    } catch (err) {
      expect((err as Error).message).toContain("VISION_PROVIDER");
      expect((err as Error).message).not.toContain("gemini");
      expect((err as Error).message).not.toContain("sk-leak");
    }
  });
});

describe("createEmbedder", () => {
  it("needs the OpenAI key even when the vision provider is anthropic", () => {
    const env = { VISION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x" };
    expect(() => createEmbedder(env)).toThrow(AiNotConfiguredError);
    expect(() => createEmbedder(env)).not.toThrow(AiNotImplementedError);
  });
});

describe("factory selection (step 6)", () => {
  it("openai key => openai adapter; anthropic key => anthropic adapter with the fallback-capable model", () => {
    expect(createVisionDescriber({ OPENAI_API_KEY: "x" }).provider).toBe("openai");
    const a = createVisionDescriber({
      VISION_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "x",
      VISION_MODEL: "claude-haiku-5-5",
    });
    expect(a.provider).toBe("anthropic");
    expect(a.model).toBe("claude-haiku-5-5");
  });

  it("fake works without any key", () => {
    const d = createVisionDescriber({ VISION_PROVIDER: "fake" });
    expect(d.provider).toBe("fake");
    expect(isAiConfigured({ VISION_PROVIDER: "fake" })).toBe(true);
  });

  it("fake in production is refused with no key echo; allowed with the opt-in and a status warning", () => {
    expect(isAiConfigured({ VISION_PROVIDER: "fake", NODE_ENV: "production" })).toBe(false);
    const ok = getAiStatus({
      VISION_PROVIDER: "fake",
      NODE_ENV: "production",
      AI_ALLOW_FAKE_IN_PRODUCTION: "true",
    });
    expect(ok).toMatchObject({ configured: true, provider: "fake" });
    expect((ok as { warning?: string }).warning).toMatch(/production/);
  });

  it("an unpriced VISION_MODEL is an AiConfigError naming the field", () => {
    expect(() => createVisionDescriber({ OPENAI_API_KEY: "x", VISION_MODEL: "gpt-9" })).toThrow(
      /VISION_MODEL/,
    );
  });

  it("an invalid pipeline setting is a config error naming only the field", () => {
    expect(() => createVisionDescriber({ OPENAI_API_KEY: "x", AI_MAX_OUTPUT_TOKENS: "5" })).toThrow(
      /AI_MAX_OUTPUT_TOKENS/,
    );
  });
});
