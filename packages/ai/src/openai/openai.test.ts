import { AI_DESCRIPTION_V1_SCHEMA_NAME, aiDescriptionV1Schema } from "@tinyglow/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysisImage } from "../../../../e2e/fixtures/ai-images";
import type { VisionAdapterOptions } from "../adapter-options";
import { AiProviderError, AiRequestError } from "../errors";
import { fakeDescription } from "../fake/describe";
import { type OpenAiMockServer, startOpenAiMockServer } from "../testing/openai-mock-server";
import type { VisionRequest } from "../types";
import { parseBatchLine, parseResponsesBody } from "./parse";
import { createOpenAiVisionDescriber } from "./vision";

// Loosely typed JSON as read back from recorded requests.
// biome-ignore lint/suspicious/noExplicitAny: test-only access to wire JSON
type Rec = Record<string, any>;

const id = (n: number) => `${n.toString(16).padStart(8, "1")}-1111-4111-8111-111111111111`;
const req = (n: number, notes: string | null = "SENTINEL-NOTE"): VisionRequest => ({
  photoId: id(n),
  plan: "paid",
  image: analysisImage(n),
  context: {
    babyAgeDays: 5,
    takenAt: "2026-06-14",
    placeLabel: "Park",
    people: [],
    milestone: null,
    parentNotes: notes,
  },
  promptVersion: "v1",
  schemaVersion: "v1",
});

let mock: OpenAiMockServer;
const logs: { level: string; obj: unknown; msg: string }[] = [];
const log = {
  debug: (obj: Record<string, unknown>, msg: string) =>
    void logs.push({ level: "debug", obj, msg }),
  info: (obj: Record<string, unknown>, msg: string) => void logs.push({ level: "info", obj, msg }),
  warn: (obj: Record<string, unknown>, msg: string) => void logs.push({ level: "warn", obj, msg }),
};
const opts = (over: Partial<VisionAdapterOptions> = {}): VisionAdapterOptions => ({
  apiKey: "sk-test-secret",
  model: "gpt-6-luna",
  reasoningEffort: "none",
  maxOutputTokens: 1200,
  maxBatchBytes: 150_000_000,
  baseUrl: mock.baseUrl,
  log,
  http: { sleep: async () => undefined, retryBaseMs: 1 },
  ...over,
});

beforeEach(() => {
  logs.length = 0;
});
afterEach(async () => {
  await mock?.close().catch(() => undefined);
});

async function setup(
  mockOpts: Parameters<typeof startOpenAiMockServer>[0] = {},
  o: Partial<VisionAdapterOptions> = {},
) {
  mock = await startOpenAiMockServer(mockOpts);
  return createOpenAiVisionDescriber(opts(o));
}

describe("describeBatch wire format", () => {
  it("uploads purpose=batch JSONL with custom_id, strict schema, store:false, effort none, data URL; creates a 24h batch", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1), req(2)]);
    const upload = mock.requests.find((r) => r.path === "/v1/files");
    expect(upload?.method).toBe("POST");
    expect(upload?.headers.authorization).toBe("Bearer sk-test-secret");
    expect(upload?.form?.purpose).toBe("batch");
    expect(upload?.form?.filename).toMatch(/^tinyglow-batch-[0-9a-f-]+\.jsonl$/);
    const lines = (upload?.form?.content ?? "")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.custom_id)).toEqual([id(1), id(2)]);
    for (const l of lines) {
      expect(l.method).toBe("POST");
      expect(l.url).toBe("/v1/responses");
      expect(l.body.model).toBe("gpt-6-luna");
      expect(l.body.store).toBe(false);
      expect(l.body.reasoning).toEqual({ effort: "none" });
      expect(l.body.text.format).toMatchObject({
        type: "json_schema",
        strict: true,
        name: AI_DESCRIPTION_V1_SCHEMA_NAME,
      });
      expect(l.body.prompt_cache_key).toBe("tinyglow-describe-v1");
      expect(l.body.input[0].content[0].type).toBe("input_image");
      expect(l.body.input[0].content[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
      expect(JSON.stringify(l)).not.toMatch(/latitude|longitude|gps/i);
    }
    const create = mock.requests.find((r) => r.path === "/v1/batches");
    expect(create?.body).toMatchObject({
      endpoint: "/v1/responses",
      completion_window: "24h",
      metadata: { app: "tinyglow", prompt_version: "v1", schema_version: "v1" },
    });
    expect(h).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      requestCount: 2,
      promptVersion: "v1",
    });
    expect(h.inputFileId).toBeTruthy();
    expect(mock.batches.get(h.batchId)?.status).toBe("validating");
  });

  it("never passes keys, bytes, notes or prompts to the logger", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1)]);
    await d.pollBatch(h);
    await d.pollBatch(h);
    const s = JSON.stringify(logs);
    expect(s).not.toContain("SENTINEL-NOTE");
    expect(s).not.toContain("sk-test-secret");
    expect(s).not.toContain("base64");
    expect(s).not.toContain("Riverside");
  });

  it("refuses a free request / oversize image / oversize batch with no network call", async () => {
    const d = await setup({}, { maxBatchBytes: 1000 });
    await expect(d.describeBatch([{ ...req(1), plan: "free" as never }])).rejects.toBeInstanceOf(
      AiRequestError,
    );
    await expect(d.describeBatch([req(1)])).rejects.toMatchObject({ code: "batch_too_large" });
    expect(mock.requests).toEqual([]);
  });

  it("blanks a coordinate-looking note before upload", async () => {
    const d = await setup();
    await d.describeBatch([req(1, "at 47.6062, -122.3321")]);
    const upload = mock.requests.find((r) => r.path === "/v1/files");
    expect(upload?.form?.content).not.toContain("47.6062");
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("blanked"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("47.6062");
  });

  it("deletes the uploaded input file when batch create fails (400), and rethrows", async () => {
    const d = await setup();
    mock.injectFailure({ method: "POST", path: "/v1/batches", status: 400, times: 1 });
    await expect(d.describeBatch([req(1)])).rejects.toBeInstanceOf(AiProviderError);
    expect(mock.deletedFiles).toHaveLength(1);
    expect(mock.files.size).toBe(0);
  });

  it("does not retry a 500 on batch create (no duplicate batch), and cleans up the file", async () => {
    const d = await setup();
    mock.injectFailure({ method: "POST", path: "/v1/batches", status: 500, times: 5 });
    await expect(d.describeBatch([req(1)])).rejects.toMatchObject({ status: 500 });
    expect(mock.requests.filter((r) => r.path === "/v1/batches")).toHaveLength(1);
    expect(mock.deletedFiles).toHaveLength(1);
  });

  it("does not retry a 500 on the upload either", async () => {
    const d = await setup();
    mock.injectFailure({ method: "POST", path: "/v1/files", status: 500, times: 5 });
    await expect(d.describeBatch([req(1)])).rejects.toMatchObject({ status: 500 });
    expect(mock.requests.filter((r) => r.path === "/v1/files")).toHaveLength(1);
  });

  it("retries a 429 on create", async () => {
    const d = await setup();
    mock.injectFailure({ method: "POST", path: "/v1/batches", status: 429, times: 1 });
    const h = await d.describeBatch([req(1)]);
    expect(h.batchId).toBeTruthy();
    expect(mock.requests.filter((r) => r.path === "/v1/batches")).toHaveLength(2);
  });
});

describe("pollBatch", () => {
  it("retries a 503 on retrieve", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1)]);
    mock.injectFailure({ method: "GET", path: `/v1/batches/${h.batchId}`, status: 503, times: 2 });
    const st = await d.pollBatch(h);
    expect(st.state).toBe("in_progress");
  });

  it("in progress, then completed with mapped results (output order differs from input)", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1), req(2), req(3)]);
    const a = await d.pollBatch(h);
    expect(a.state).toBe("in_progress");
    expect(a.results).toBeUndefined();
    const b = await d.pollBatch(h);
    expect(b.state).toBe("completed");
    expect(b.results?.map((r) => r.photoId).sort()).toEqual([id(1), id(2), id(3)].sort());
    for (const r of b.results ?? []) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(aiDescriptionV1Schema.safeParse(r.raw).success).toBe(true);
        expect(r.usage).toMatchObject({
          inputTokens: 1400,
          cachedInputTokens: 700,
          outputTokens: 400,
          reasoningTokens: 0,
        });
        expect(r.usage.costUsd).toBeCloseTo(0.0001385, 10);
      }
    }
    expect(b.usage?.costUsd).toBeCloseTo(3 * 0.0001385, 9);
    expect(b.outputFileId).toBeTruthy();
    expect(b.requestCounts).toEqual({ total: 3, completed: 3, failed: 0 });
    expect(b.expiresAt).toBeTruthy();
  });

  it("maps refusal / max tokens / invalid json / 429 / 500 / expired lines", async () => {
    const outcomes = [
      "ok",
      "refusal",
      "incomplete",
      "invalid_json",
      "error_429",
      "error_500",
      "expired",
    ] as const;
    const d = await setup({
      completeAfterPolls: 0,
      outcome: (cid) => outcomes[parseInt((cid ?? "1").slice(0, 8), 16) - 0x11111111] ?? "ok",
    });
    const reqs = outcomes.map((_o, i) => ({
      ...req(1),
      photoId: `${(0x11111111 + i).toString(16)}-1111-4111-8111-111111111111`,
    }));
    const h = await d.describeBatch(reqs);
    const st = await d.pollBatch(h);
    expect(st.state).toBe("expired");
    const by = new Map((st.results ?? []).map((r) => [r.photoId, r]));
    const get = (i: number) => by.get(reqs[i]?.photoId as string);
    expect(get(0)?.ok).toBe(true);
    expect(get(1)).toMatchObject({ ok: false, failure: "refusal", detail: "refusal" });
    expect(get(1)?.usage).toBeTruthy();
    expect(get(2)).toMatchObject({
      ok: false,
      failure: "invalid_output",
      detail: "max_output_tokens",
    });
    expect(get(3)).toMatchObject({ ok: false, failure: "invalid_output", detail: "json_parse" });
    expect(get(4)).toMatchObject({ ok: false, failure: "rate_limited" });
    expect(get(5)).toMatchObject({ ok: false, failure: "provider_error" });
    expect(get(6)).toMatchObject({ ok: false, failure: "expired", detail: "batch_expired" });
    // no result ever carries the refused / truncated text
    expect(JSON.stringify(st.results)).not.toContain("can't help");
    expect(JSON.stringify(st.results)).not.toContain('{"caption": "A baby');
  });

  it("a failed (validation) batch reports the code and no results", async () => {
    const d = await setup({ failValidation: true });
    const h = await d.describeBatch([req(1)]);
    const st = await d.pollBatch(h);
    expect(st.state).toBe("failed");
    expect(st.failureCode).toBe("invalid_request");
    expect(st.results).toEqual([]);
  });

  it("reasoning tokens are reported when the model spends them", async () => {
    const d = await setup({
      completeAfterPolls: 0,
      usage: { input: 1400, cached: 0, output: 400, reasoning: 50 },
    });
    const h = await d.describeBatch([req(1)]);
    const st = await d.pollBatch(h);
    expect(st.results?.[0]?.usage?.reasoningTokens).toBe(50);
  });
});

describe("deleteBatchArtifacts", () => {
  it("deletes input, output and error files; tolerates 404", async () => {
    const d = await setup({
      completeAfterPolls: 0,
      outcome: (c) => (c === id(2) ? "error_500" : "ok"),
    });
    const h = await d.describeBatch([req(1), req(2)]);
    const st = await d.pollBatch(h);
    expect(st.outputFileId && st.errorFileId && h.inputFileId).toBeTruthy();
    const out = await d.deleteBatchArtifacts(h, st);
    expect(out.deleted.sort()).toEqual([h.inputFileId, st.outputFileId, st.errorFileId].sort());
    expect(mock.deletedFiles).toHaveLength(3);
    expect(mock.files.size).toBe(0);
    // second call: all 404, still success
    const again = await d.deleteBatchArtifacts(h, st);
    expect(again.deleted).toHaveLength(3);
  });
  it("without a status it retrieves the batch first", async () => {
    const d = await setup({ completeAfterPolls: 0 });
    const h = await d.describeBatch([req(1)]);
    await d.pollBatch(h);
    const out = await d.deleteBatchArtifacts(h);
    expect(out.deleted).toHaveLength(2);
  });
  it("throws (after trying the rest) when one deletion fails with 500", async () => {
    const d = await setup({ completeAfterPolls: 0 });
    const h = await d.describeBatch([req(1)]);
    const st = await d.pollBatch(h);
    mock.injectFailure({
      method: "DELETE",
      path: `/v1/files/${h.inputFileId}`,
      status: 400,
      times: 1,
    });
    await expect(d.deleteBatchArtifacts(h, st)).rejects.toBeInstanceOf(AiProviderError);
    expect(mock.deletedFiles).toContain(st.outputFileId);
  });
});

describe("cancel and describeOne", () => {
  it("cancel hits /cancel", async () => {
    const d = await setup();
    const h = await d.describeBatch([req(1)]);
    await d.cancelBatch(h);
    expect(mock.requests.at(-1)?.path).toBe(`/v1/batches/${h.batchId}/cancel`);
  });
  it("describeOne maps ok, and 429 to rate_limited", async () => {
    const d = await setup();
    const r = await d.describeOne(req(1));
    expect(r.ok).toBe(true);
    const body = mock.requests.find((x) => x.path === "/v1/responses")?.body as Rec;
    expect(body.store).toBe(false);
    mock.injectFailure({ method: "POST", path: "/v1/responses", status: 429, times: 10 });
    const limited = await d.describeOne(req(2));
    expect(limited).toMatchObject({ ok: false, failure: "rate_limited" });
  });
});

describe("construction and parsing", () => {
  it("an unpriced model throws at construction", () => {
    expect(() =>
      createOpenAiVisionDescriber({ ...opts({ baseUrl: "http://x" }), model: "gpt-9" }),
    ).toThrow(/VISION_MODEL/);
  });
  it("parseBatchLine tolerates junk and returns null without custom_id", () => {
    expect(parseBatchLine("not json", "gpt-6-luna")).toBeNull();
    expect(parseBatchLine('{"id":"x"}', "gpt-6-luna")).toBeNull();
    expect(
      parseBatchLine('{"custom_id":"a","response":null,"error":null}', "gpt-6-luna"),
    ).toMatchObject({ ok: false, detail: "no_response" });
  });
  it("parseResponsesBody: output_text fallback, failed status, empty body", () => {
    const text = JSON.stringify(fakeDescription("a"));
    expect(
      parseResponsesBody({ status: "completed", output_text: text }, "a", "gpt-6-luna", "batch"),
    ).toMatchObject({ ok: true });
    expect(
      parseResponsesBody(
        { status: "failed", error: { code: "server_error" } },
        "a",
        "gpt-6-luna",
        "batch",
      ),
    ).toMatchObject({ ok: false, failure: "provider_error" });
    expect(parseResponsesBody(null, "a", "gpt-6-luna", "batch")).toMatchObject({
      ok: false,
      detail: "empty_body",
    });
    expect(
      parseResponsesBody({ status: "completed", output: [] }, "a", "gpt-6-luna", "batch"),
    ).toMatchObject({ ok: false, detail: "no_output_text" });
  });
  it("errors carry status and code only (no body, no key)", async () => {
    const d = await setup();
    mock.injectFailure({
      method: "POST",
      path: "/v1/files",
      status: 400,
      times: 1,
      body: {
        error: { message: "SECRET-BODY sk-test-secret", type: "invalid_request_error", code: null },
      },
    });
    const err = await d.describeBatch([req(1)]).catch((e) => e);
    expect(err.message).not.toContain("SECRET-BODY");
    expect(err.message).not.toContain("sk-test-secret");
    expect(err.code).toBe("invalid_request_error");
  });
});
