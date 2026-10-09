import { aiDescriptionV1Schema } from "@littlelight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysisImage } from "../../../../e2e/fixtures/ai-images";
import type { VisionAdapterOptions } from "../adapter-options";
import { AiProviderError, AiRequestError } from "../errors";
import {
  type AnthropicMockOptions,
  type AnthropicMockServer,
  startAnthropicMockServer,
} from "../testing/anthropic-mock-server";
import type { VisionRequest } from "../types";
import { anthropicUsage, parseResultLine } from "./parse";
import { createAnthropicVisionDescriber } from "./vision";

// Loosely typed JSON as read back from recorded requests.
// biome-ignore lint/suspicious/noExplicitAny: test-only access to wire JSON
type Rec = Record<string, any>;

const id = (n: number) => `${n.toString(16).padStart(8, "1")}-1111-4111-8111-111111111111`;
const req = (n: number): VisionRequest => ({
  photoId: id(n),
  plan: "paid",
  image: analysisImage(n),
  context: {
    babyAgeDays: 5,
    takenAt: null,
    placeLabel: null,
    people: [],
    milestone: null,
    parentNotes: "SENTINEL-NOTE",
  },
  promptVersion: "v1",
  schemaVersion: "v1",
});

let mock: AnthropicMockServer;
const logs: unknown[] = [];
const log = {
  debug: (o: Record<string, unknown>, m: string) => void logs.push([o, m]),
  info: (o: Record<string, unknown>, m: string) => void logs.push([o, m]),
  warn: (o: Record<string, unknown>, m: string) => void logs.push([o, m]),
};
beforeEach(() => {
  logs.length = 0;
});
afterEach(async () => {
  await mock?.close().catch(() => undefined);
});

async function setup(m: AnthropicMockOptions = {}, o: Partial<VisionAdapterOptions> = {}) {
  mock = await startAnthropicMockServer(m);
  return createAnthropicVisionDescriber({
    apiKey: "sk-ant-secret",
    model: "claude-haiku-5-5",
    reasoningEffort: "none",
    maxOutputTokens: 1200,
    maxBatchBytes: 150_000_000,
    baseUrl: mock.baseUrl,
    log,
    http: { sleep: async () => undefined, retryBaseMs: 1 },
    ...o,
  });
}

describe("describeBatch", () => {
  it("sends x-api-key + anthropic-version, one request per photo with custom_id and params", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1), req(2)]);
    const create = mock.requests.find(
      (r) => r.path === "/v1/messages/batches" && r.method === "POST",
    );
    expect(create?.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(create?.headers["anthropic-version"]).toBe("2023-06-01");
    const body = create?.body as { requests: { custom_id: string; params: Rec }[] };
    expect(body.requests.map((r) => r.custom_id)).toEqual([id(1), id(2)]);
    const p = body.requests[0]?.params as Rec;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.thinking).toEqual({ type: "disabled" });
    expect(p.output_config.effort).toBe("low");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.system[0].cache_control.ttl).toBe("1h");
    expect(p.messages[0].content[0].source.type).toBe("base64");
    expect(h).toMatchObject({ provider: "anthropic", requestCount: 2, model: "claude-haiku-5-5" });
    expect(h.inputFileId).toBeUndefined();
  });

  it("refuses free / oversize batch before any network call; does not retry a 500 create", async () => {
    const d = await setup({}, { maxBatchBytes: 500 });
    await expect(d.describeBatch([{ ...req(1), plan: "free" as never }])).rejects.toBeInstanceOf(
      AiRequestError,
    );
    await expect(d.describeBatch([req(1)])).rejects.toMatchObject({ code: "batch_too_large" });
    expect(mock.requests).toEqual([]);
    const d2 = createAnthropicVisionDescriber({
      apiKey: "k",
      model: "claude-haiku-5-5",
      reasoningEffort: "none",
      maxOutputTokens: 1200,
      maxBatchBytes: 150_000_000,
      baseUrl: mock.baseUrl,
      http: { sleep: async () => undefined },
    });
    mock.injectFailure({ method: "POST", path: "/v1/messages/batches", status: 500, times: 5 });
    await expect(d2.describeBatch([req(1)])).rejects.toBeInstanceOf(AiProviderError);
    expect(mock.requests).toHaveLength(1);
  });

  it("never logs keys, notes or bytes", async () => {
    const d = await setup({ completeAfterPolls: 0 });
    const h = await d.describeBatch([req(1)]);
    await d.pollBatch(h);
    const s = JSON.stringify(logs);
    expect(s).not.toContain("sk-ant-secret");
    expect(s).not.toContain("SENTINEL-NOTE");
    expect(s).not.toContain("base64");
  });
});

describe("pollBatch and results", () => {
  it("in progress then completed with valid results and normalised usage", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1), req(2)]);
    const a = await d.pollBatch(h);
    expect(a.state).toBe("in_progress");
    const b = await d.pollBatch(h);
    expect(b.state).toBe("completed");
    expect(b.results).toHaveLength(2);
    for (const r of b.results ?? []) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(aiDescriptionV1Schema.safeParse(r.raw).success).toBe(true);
        // mock: input 700 uncached + 700 cache read, 400 output => normalised input 1400
        expect(r.usage).toMatchObject({
          inputTokens: 1400,
          cachedInputTokens: 700,
          outputTokens: 400,
        });
        expect(r.usage.costUsd).toBeCloseTo(0.0001385, 10);
      }
    }
    expect(b.requestCounts).toEqual({ total: 2, completed: 2, failed: 0 });
  });

  it("maps refusal, max_tokens, invalid json, rate limit, server error, expired, canceled", async () => {
    const outcomes = [
      "ok",
      "refusal",
      "max_tokens",
      "invalid_json",
      "errored_rate_limit",
      "errored_server",
      "expired",
      "canceled",
    ] as const;
    const d = await setup({
      completeAfterPolls: 0,
      outcome: (c) => outcomes[parseInt((c ?? "1").slice(0, 8), 16) - 0x11111111] ?? "ok",
    });
    const reqs = outcomes.map((_o, i) => ({
      ...req(1),
      photoId: `${(0x11111111 + i).toString(16)}-1111-4111-8111-111111111111`,
    }));
    const h = await d.describeBatch(reqs);
    const st = await d.pollBatch(h);
    expect(st.state).toBe("completed");
    const by = (i: number) => st.results?.find((r) => r.photoId === reqs[i]?.photoId);
    expect(by(0)?.ok).toBe(true);
    expect(by(1)).toMatchObject({ failure: "refusal" });
    expect(by(2)).toMatchObject({ failure: "invalid_output", detail: "max_tokens" });
    expect(by(3)).toMatchObject({ failure: "invalid_output", detail: "json_parse" });
    expect(by(4)).toMatchObject({ failure: "rate_limited", detail: "rate_limit_error" });
    expect(by(5)).toMatchObject({ failure: "provider_error", detail: "api_error" });
    expect(by(6)).toMatchObject({ failure: "expired" });
    expect(by(7)).toMatchObject({ failure: "expired", detail: "canceled" });
    expect(JSON.stringify(st.results)).not.toContain("can't help");
  });

  it("a batch where every request expired is state expired", async () => {
    const d = await setup({ completeAfterPolls: 0, outcome: () => "expired" });
    const h = await d.describeBatch([req(1), req(2)]);
    expect((await d.pollBatch(h)).state).toBe("expired");
  });

  it("DELETE only after the batch ended; the mock rejects an early delete", async () => {
    const d = await setup({ completeAfterPolls: 1 });
    const h = await d.describeBatch([req(1)]);
    await expect(d.deleteBatchArtifacts(h)).rejects.toBeInstanceOf(AiProviderError);
    expect(mock.deletedBatches).toEqual([]);
    await d.pollBatch(h);
    await d.pollBatch(h);
    expect(await d.deleteBatchArtifacts(h)).toEqual({ deleted: [h.batchId] });
    expect(mock.deletedBatches).toEqual([h.batchId]);
    // already gone => 404 tolerated
    expect(await d.deleteBatchArtifacts(h)).toEqual({ deleted: [h.batchId] });
  });

  it("cancel goes to /cancel and the batch then reports cancelled-or-ended", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1)]);
    await d.cancelBatch(h);
    expect(mock.requests.at(-1)?.path).toBe(`/v1/messages/batches/${h.batchId}/cancel`);
  });

  it("describeOne maps success and 429", async () => {
    const d = await setup();
    expect((await d.describeOne(req(1))).ok).toBe(true);
    mock.injectFailure({ method: "POST", path: "/v1/messages", status: 429, times: 10 });
    expect(await d.describeOne(req(2))).toMatchObject({ ok: false, failure: "rate_limited" });
  });
});

describe("parsing", () => {
  it("anthropicUsage prices 1h cache writes and normalises input", () => {
    const u = anthropicUsage(
      {
        input_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_1h_input_tokens: 300 },
        output_tokens: 50,
      },
      "claude-haiku-5-5",
      "batch",
    );
    expect(u.inputTokens).toBe(600);
    expect(u.cacheWriteTokens).toBe(300);
    expect(u.costUsd).toBeCloseTo((100 * 0.05 + 200 * 0.005 + 300 * 0.1 + 50 * 0.25) / 1e6, 12);
  });
  it("parseResultLine tolerates junk", () => {
    expect(parseResultLine("nope", "claude-haiku-5-5")).toBeNull();
    expect(parseResultLine('{"result":{}}', "claude-haiku-5-5")).toBeNull();
    expect(
      parseResultLine('{"custom_id":"a","result":{"type":"weird"}}', "claude-haiku-5-5"),
    ).toMatchObject({ detail: "unknown_result" });
  });
  it("unpriced model throws at construction", () => {
    expect(() =>
      createAnthropicVisionDescriber({
        apiKey: "k",
        model: "claude-x",
        reasoningEffort: "none",
        maxOutputTokens: 1,
        maxBatchBytes: 1,
      }),
    ).toThrow(/VISION_MODEL/);
  });
});
