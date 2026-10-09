import { describe, expect, it } from "vitest";
import { aiPipelineConfig, createAiRuntime } from "./ai-runtime";
import { recordingLog } from "./testing/stubs";

describe("createAiRuntime", () => {
  it("without a key: describer null, a clear info line that names the env var only", () => {
    const log = recordingLog();
    const rt = createAiRuntime({}, log);
    expect(rt.describer).toBeNull();
    expect(rt.disabledReason).toBe("OPENAI_API_KEY not set");
    expect(log.lines.map((l) => [l.level, l.msg])).toEqual([
      ["info", "AI disabled: OPENAI_API_KEY not set"],
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
    expect(log.lines.some((l) => l.msg === "AI enabled: provider=fake model=gpt-6-luna")).toBe(
      true,
    );
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
