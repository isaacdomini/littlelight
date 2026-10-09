import { describe, expect, it } from "vitest";
import { ConfigError, chatSettings, loadConfig, searchSettings } from "./config";

const SECRET = "dev-only-jwt-secret-at-least-32-characters";
const env = {
  DATABASE_URL: "postgres://postgres:pw@db:5432/littlelight",
  S3_ENDPOINT: "http://storage:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "dev",
  S3_SECRET_KEY: "devdevdev",
  S3_BUCKET: "littlelight-dev",
  JWT_SECRET: SECRET,
  GOTRUE_JWT_SECRET: SECRET,
  DATA_ENCRYPTION_KEY: "dev-only-data-encryption-key-32-chars-min",
  PUBLIC_URL: "http://localhost:8080",
  SMTP_HOST: "mail",
  MAIL_FROM: "noreply@littlelight.test",
};

describe("loadConfig: step 7 settings", () => {
  it("applies the search and chat defaults", () => {
    const cfg = loadConfig(env);
    expect(searchSettings(cfg)).toMatchObject({ SEARCH_EXACT_MAX: 2000, SEARCH_RERANK: "off" });
    expect(chatSettings(cfg)).toEqual({
      CHAT_TURNS_PER_DAY: 100,
      CHAT_MAX_TOOL_ROUNDS: 4,
      CHAT_MAX_OUTPUT_TOKENS: 800,
      CHAT_HISTORY_MESSAGES: 20,
      CHAT_MODEL_TIMEOUT_MS: 30_000,
      CHAT_FAST_PATH: true,
    });
  });

  it("reads overrides and rejects out-of-range values, naming only the field", () => {
    const cfg = loadConfig({ ...env, CHAT_TURNS_PER_DAY: "5", SEARCH_RERANK: "llm" });
    expect(cfg.CHAT_TURNS_PER_DAY).toBe(5);
    expect(cfg.SEARCH_RERANK).toBe("llm");
    try {
      loadConfig({ ...env, CHAT_TURNS_PER_DAY: "secret-0" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).fields).toHaveLength(1);
      expect((e as ConfigError).fields[0]).toMatch(/^CHAT_TURNS_PER_DAY\b/);
      expect((e as Error).message).not.toContain("secret-0");
    }
  });

  it("CHAT_FAST_PATH can be switched off and is read from the env", () => {
    expect(chatSettings(loadConfig({ ...env, CHAT_FAST_PATH: "false" })).CHAT_FAST_PATH).toBe(
      false,
    );
    expect(chatSettings(loadConfig({ ...env, CHAT_FAST_PATH: "true" })).CHAT_FAST_PATH).toBe(true);
    expect(() => loadConfig({ ...env, CHAT_FAST_PATH: "maybe" })).toThrow(ConfigError);
  });

  it("CHAT_FAST_PATH_MIN_SIMILARITY is passed through chatSettings only when set", () => {
    expect(chatSettings(loadConfig(env))).not.toHaveProperty("CHAT_FAST_PATH_MIN_SIMILARITY");
    expect(
      chatSettings(loadConfig({ ...env, CHAT_FAST_PATH_MIN_SIMILARITY: "0.5" }))
        .CHAT_FAST_PATH_MIN_SIMILARITY,
    ).toBe(0.5);
    expect(() => loadConfig({ ...env, CHAT_FAST_PATH_MIN_SIMILARITY: "2" })).toThrow(ConfigError);
  });

  it("SEARCH_MIN_SIMILARITY is passed through searchSettings only when set", () => {
    expect(searchSettings(loadConfig(env))).not.toHaveProperty("SEARCH_MIN_SIMILARITY");
    expect(
      searchSettings(loadConfig({ ...env, SEARCH_MIN_SIMILARITY: "0.3" })).SEARCH_MIN_SIMILARITY,
    ).toBe(0.3);
    expect(() => loadConfig({ ...env, SEARCH_MIN_SIMILARITY: "2" })).toThrow(ConfigError);
  });

  it("refuses to boot with EMBED_DIMS other than the 1024-wide column", () => {
    expect(() => loadConfig({ ...env, EMBED_DIMS: "512" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, EMBED_DIMS: "1024" })).not.toThrow();
    expect(() => loadConfig({ ...env, EMBED_DIMS: "" })).not.toThrow();
    try {
      loadConfig({ ...env, EMBED_DIMS: "3072" });
    } catch (e) {
      expect((e as ConfigError).fields).toHaveLength(1);
      expect((e as ConfigError).fields[0]).toMatch(/^EMBED_DIMS\b/);
      expect((e as Error).message).not.toContain("3072");
    }
  });

  it("does not carry provider keys or EMBED_DIMS in the config object", () => {
    const cfg = loadConfig({ ...env, OPENAI_API_KEY: "sk-secret", EMBED_DIMS: "1024" });
    expect(JSON.stringify(cfg)).not.toContain("sk-secret");
    expect(cfg).not.toHaveProperty("OPENAI_API_KEY");
    expect(cfg).not.toHaveProperty("EMBED_DIMS");
  });
});
