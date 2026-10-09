import { describe, expect, it } from "vitest";
import { aiPipelineConfig, createAiRuntime, searchIndexerConfig } from "./ai-runtime";
import { recordingLog } from "./testing/stubs";

describe("createAiRuntime", () => {
  it("without a key: describer null, a clear info line that names the env var only", () => {
    const log = recordingLog();
    const rt = createAiRuntime({}, log);
    expect(rt.describer).toBeNull();
    expect(rt.disabledReason).toBe("OPENAI_API_KEY not set");
    expect(rt.embedder).toBeNull();
    expect(rt.embedDisabledReason).toBe("OPENAI_API_KEY not set");
    expect(log.lines.map((l) => [l.level, l.msg])).toEqual([
      ["info", "AI disabled: OPENAI_API_KEY not set"],
      [
        "info",
        "search: embeddings disabled (OPENAI_API_KEY not set); keyword search and filters still work",
      ],
    ]);
  });

  it("an empty key counts as unset (compose passes OPENAI_API_KEY=)", () => {
    expect(createAiRuntime({ OPENAI_API_KEY: "" }, recordingLog()).describer).toBeNull();
  });

  it("with the fake provider: a describer without any key, 'AI enabled' line", () => {
    const log = recordingLog();
    const rt = createAiRuntime({ VISION_PROVIDER: "fake" }, log);
    expect(rt.describer?.provider).toBe("fake");
    expect(rt.disabledReason).toBeUndefined();
    expect(rt.embedder?.model).toBe("fake");
    expect(rt.embedder?.dims).toBe(1024);
    expect(
      log.lines.some(
        (l) => l.msg === "AI enabled: provider=fake vision=gpt-6-luna embed=fake/1024",
      ),
    ).toBe(true);
    expect(log.lines.some((l) => l.msg.startsWith("search: embeddings disabled"))).toBe(false);
  });

  it("with an OpenAI key: describer and embedder both exist, one AI enabled line", () => {
    const log = recordingLog();
    const rt = createAiRuntime({ OPENAI_API_KEY: "sk-secret-123" }, log);
    expect(rt.embedder?.model).toBe("text-embedding-3-small");
    expect(log.lines.map((l) => l.msg)).toContain(
      "AI enabled: provider=openai vision=gpt-6-luna embed=text-embedding-3-small/1024",
    );
  });

  it("an Anthropic-only deployment has a describer but no embedder (embeddings are OpenAI only)", () => {
    const log = recordingLog();
    const rt = createAiRuntime(
      {
        VISION_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        VISION_MODEL: "claude-haiku-5-5",
      },
      log,
    );
    expect(rt.describer?.provider).toBe("anthropic");
    expect(rt.embedder).toBeNull();
    expect(rt.embedDisabledReason).toMatch(/OPENAI_API_KEY/);
    expect(
      log.lines.some((l) => l.msg.startsWith("AI enabled") && l.msg.includes("embed=off")),
    ).toBe(true);
    expect(JSON.stringify(log.lines)).not.toContain("sk-ant-secret");
  });

  it("an unpriced EMBED_MODEL disables only the embedder (describer still built), names the field", () => {
    const log = recordingLog();
    const rt = createAiRuntime({ OPENAI_API_KEY: "sk-x", EMBED_MODEL: "embed-9" }, log);
    expect(rt.describer).not.toBeNull();
    expect(rt.embedder).toBeNull();
    expect(rt.embedDisabledReason).toMatch(/EMBED_MODEL/);
    expect(JSON.stringify(log.lines)).not.toMatch(/embed-9|sk-x/);
  });

  it("an unpriced VISION_MODEL disables only the describer; the embedder survives", () => {
    const rt = createAiRuntime({ OPENAI_API_KEY: "sk-x", VISION_MODEL: "gpt-9" }, recordingLog());
    expect(rt.describer).toBeNull();
    expect(rt.embedder).not.toBeNull();
  });

  it("with an OpenAI key: an openai describer; the key never reaches a log line", () => {
    const log = recordingLog();
    const rt = createAiRuntime({ OPENAI_API_KEY: "sk-secret-123" }, log);
    expect(rt.describer?.provider).toBe("openai");
    expect(JSON.stringify(log.lines)).not.toContain("sk-secret-123");
  });

  it("the fake provider is refused in production (describer null, reason says so)", () => {
    const log = recordingLog();
    const rt = createAiRuntime({ VISION_PROVIDER: "fake", NODE_ENV: "production" }, log);
    expect(rt.describer).toBeNull();
    expect(rt.disabledReason).toMatch(/refused in production/);
    expect(log.lines.some((l) => l.msg.startsWith("AI disabled"))).toBe(true);
  });

  it("the fake provider in production with the explicit opt-in runs and warns", () => {
    const log = recordingLog();
    const rt = createAiRuntime(
      { VISION_PROVIDER: "fake", NODE_ENV: "production", AI_ALLOW_FAKE_IN_PRODUCTION: "true" },
      log,
    );
    expect(rt.describer?.provider).toBe("fake");
    expect(log.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("an invalid AI config never throws: describer null, field names only", () => {
    const log = recordingLog();
    const rt = createAiRuntime({ VISION_PROVIDER: "gemini", OPENAI_API_KEY: "sk-leak" }, log);
    expect(rt.describer).toBeNull();
    expect(rt.disabledReason).toMatch(/VISION_PROVIDER/);
    expect(JSON.stringify(log.lines)).not.toMatch(/gemini|sk-leak/);
    const bad = createAiRuntime({ OPENAI_API_KEY: "x", VISION_MODEL: "gpt-9" }, recordingLog());
    expect(bad.describer).toBeNull();
    expect(bad.disabledReason).toMatch(/VISION_MODEL/);
  });
});

describe("aiPipelineConfig", () => {
  const cfg = {
    AI_BATCH_MAX_PHOTOS: 10,
    AI_BATCH_FLUSH_MINUTES: 0,
    AI_BATCH_MAX_BYTES: 5_000_000,
    AI_MAX_ATTEMPTS: 3,
    AI_BABY_MONTHLY_BUDGET_USD: 0.0001,
    AI_BUDGET_ALERT_PCT: 90,
    AI_QUEUE_AGE_ALERT_MINUTES: 60,
  } as never;

  it("copies the pipeline settings and pins the current versions", () => {
    expect(aiPipelineConfig(cfg, {})).toMatchObject({
      AI_BATCH_MAX_PHOTOS: 10,
      AI_BATCH_FLUSH_MINUTES: 0,
      AI_BATCH_MAX_BYTES: 5_000_000,
      AI_MAX_ATTEMPTS: 3,
      AI_BABY_MONTHLY_BUDGET_USD: 0.0001,
      AI_BUDGET_ALERT_PCT: 90,
      AI_QUEUE_AGE_ALERT_MINUTES: 60,
      promptVersion: "v1",
      schemaVersion: "v1",
      VISION_REASONING_EFFORT: "none",
    });
  });

  it("uses the configured reasoning effort, falling back to none on an invalid config", () => {
    expect(aiPipelineConfig(cfg, { VISION_REASONING_EFFORT: "low" }).VISION_REASONING_EFFORT).toBe(
      "low",
    );
    expect(
      aiPipelineConfig(cfg, { VISION_REASONING_EFFORT: "extreme" }).VISION_REASONING_EFFORT,
    ).toBe("none");
  });
});

describe("searchIndexerConfig", () => {
  const cfg = { SEARCH_EMBED_BATCH: 50, AI_BABY_MONTHLY_BUDGET_USD: 2.5 };

  it("uses the embedder's model tag, the doc version and passes the budget through", () => {
    expect(searchIndexerConfig(cfg, {}, { model: "fake", dims: 1024 })).toEqual({
      SEARCH_EMBED_BATCH: 50,
      embedModelTag: "fake/1024",
      docVersion: "v1",
      AI_BABY_MONTHLY_BUDGET_USD: 2.5,
    });
  });

  it("without an embedder the tag comes from env so rows are re-embedded once a key appears", () => {
    expect(searchIndexerConfig(cfg, {}, null).embedModelTag).toBe("text-embedding-3-small/1024");
    expect(
      searchIndexerConfig(cfg, { EMBED_MODEL: "text-embedding-3-large" }, null).embedModelTag,
    ).toBe("text-embedding-3-large/1024");
  });

  it("falls back to the defaults on an invalid AI env", () => {
    expect(searchIndexerConfig(cfg, { VISION_PROVIDER: "gemini" }, null).embedModelTag).toBe(
      "text-embedding-3-small/1024",
    );
  });
});
