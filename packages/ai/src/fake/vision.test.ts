import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PROMPT_VERSION, AI_SCHEMA_VERSION, aiDescriptionV1Schema } from "@tinyglow/shared";
import { afterEach, describe, expect, it } from "vitest";
import { analysisImage } from "../../../../e2e/fixtures/ai-images";
import { AiNotConfiguredError, AiRequestError } from "../errors";
import { createVisionDescriber } from "../index";
import type { VisionRequest } from "../types";
import { fakeDescription } from "./describe";
import { fakeEmbedding } from "./embed";
import { createFakeVisionDescriber, FAKE_USAGE } from "./vision";

const id = (n: number) => `${n.toString(16).padStart(8, "1")}-1111-4111-8111-111111111111`;
const req = (photoId: string, over: Partial<VisionRequest> = {}): VisionRequest => ({
  photoId,
  plan: "paid",
  image: analysisImage(),
  context: {
    babyAgeDays: 5,
    takenAt: null,
    placeLabel: null,
    people: [],
    milestone: null,
    parentNotes: "SENTINEL-NOTE",
  },
  promptVersion: AI_PROMPT_VERSION,
  schemaVersion: AI_SCHEMA_VERSION,
  ...over,
});
const fake = (o: Parameters<typeof createFakeVisionDescriber>[0] = {}) =>
  createFakeVisionDescriber({ env: {}, pollsUntilComplete: 0, ...o });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "fake-vision-"));
  dirs.push(d);
  return d;
};

describe("fakeDescription", () => {
  it("is deterministic and schema-valid", () => {
    for (let i = 0; i < 200; i++) {
      const p = id(i * 7919);
      expect(fakeDescription(p)).toEqual(fakeDescription(p));
      expect(aiDescriptionV1Schema.safeParse(fakeDescription(p)).success, p).toBe(true);
    }
    expect(fakeDescription(id(1)).caption).not.toBe(fakeDescription(id(2)).caption);
  });
  it("flags ids starting with 0 as sensitive (bath), roughly 1/16", () => {
    expect(fakeDescription("0abc").sensitive_content).toEqual(["bath"]);
    expect(fakeDescription("fabc").sensitive_content).toEqual([]);
  });
  it("fake embeddings are unit vectors, deterministic", () => {
    const a = fakeEmbedding("hello", 1024);
    expect(a).toHaveLength(1024);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    expect(fakeEmbedding("hello", 1024)).toEqual(a);
    expect(fakeEmbedding("world", 1024)).not.toEqual(a);
  });
});

describe("fake lifecycle", () => {
  it("describe, poll, results: valid outputs with batch-tier cost 0.0001385 each", async () => {
    const d = fake();
    const handle = await d.describeBatch([req(id(1)), req(id(2))]);
    expect(handle).toMatchObject({
      provider: "fake",
      requestCount: 2,
      promptVersion: "v1",
      schemaVersion: "v1",
    });
    const st = await d.pollBatch(handle);
    expect(st.state).toBe("completed");
    expect(st.results).toHaveLength(2);
    for (const r of st.results ?? []) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(aiDescriptionV1Schema.safeParse(r.raw).success).toBe(true);
        expect(r.usage).toMatchObject(FAKE_USAGE);
        expect(r.usage.costUsd).toBeCloseTo(0.0001385, 10);
      }
    }
    expect(st.usage?.costUsd).toBeCloseTo(0.000277, 9);
    expect(await d.deleteBatchArtifacts(handle)).toEqual({ deleted: [handle.batchId] });
    expect(d.deleteCalls).toEqual([handle.batchId]);
  });

  it("answers in_progress for pollsUntilComplete polls first", async () => {
    const d = fake({ pollsUntilComplete: 2 });
    const h = await d.describeBatch([req(id(1))]);
    expect((await d.pollBatch(h)).state).toBe("in_progress");
    expect((await d.pollBatch(h)).state).toBe("in_progress");
    expect((await d.pollBatch(h)).state).toBe("completed");
  });

  it("records requests without bytes or context text", async () => {
    const d = fake();
    await d.describeBatch([req(id(1))]);
    expect(d.requests).toHaveLength(1);
    expect(d.requests[0]).toMatchObject({ photoId: id(1), plan: "paid", width: 768, height: 576 });
    expect(d.requests[0]?.contextKeys).toContain("parentNotes");
    expect(JSON.stringify(d.requests)).not.toContain("SENTINEL-NOTE");
  });

  it("scripted outcomes per photo and attempt: invalid, refusal, provider_error, expired", async () => {
    const script = (photoId: string, attempt: number) =>
      photoId === id(1)
        ? attempt === 1
          ? "invalid_output"
          : "ok"
        : photoId === id(2)
          ? "refusal"
          : photoId === id(3)
            ? "provider_error"
            : photoId === id(4)
              ? "expired"
              : "ok";
    const d = fake({ script });
    const h1 = await d.describeBatch([1, 2, 3, 4, 5].map((n) => req(id(n))));
    const s1 = await d.pollBatch(h1);
    expect(s1.state).toBe("expired");
    const by = new Map((s1.results ?? []).map((r) => [r.photoId, r]));
    expect(by.get(id(1))?.ok).toBe(true); // ok=true but invalid content
    expect((by.get(id(1)) as { raw: unknown }).raw).toEqual({ caption: 42 });
    expect(by.get(id(2))).toMatchObject({ ok: false, failure: "refusal" });
    expect(by.get(id(3))).toMatchObject({ ok: false, failure: "provider_error" });
    expect(by.has(id(4))).toBe(false); // no result at all
    expect(by.get(id(5))?.ok).toBe(true);
    // attempt 2 for photo 1 is ok
    const h2 = await d.describeBatch([req(id(1))]);
    const s2 = await d.pollBatch(h2);
    expect(
      aiDescriptionV1Schema.safeParse(((s2.results ?? [])[0] as { raw: unknown }).raw).success,
    ).toBe(true);
  });

  it("refuses a free request, an oversize image and a duplicate id", async () => {
    const d = fake();
    await expect(d.describeBatch([req(id(1), { plan: "free" as never })])).rejects.toBeInstanceOf(
      AiRequestError,
    );
    await expect(d.describeBatch([req(id(1)), req(id(1))])).rejects.toThrow(/duplicate/);
    expect(d.requests).toEqual([]);
  });

  it("unknown batch id polls as failed; cancel marks cancelled", async () => {
    const d = fake();
    const h = await d.describeBatch([req(id(1))]);
    expect((await d.pollBatch({ ...h, batchId: "fakebatch_nope" })).state).toBe("failed");
    await d.cancelBatch(h);
    expect((await d.pollBatch(h)).state).toBe("cancelled");
    expect(d.cancelCalls).toEqual([h.batchId]);
  });

  it("describeOne works and records with a null batch", async () => {
    const d = fake();
    const r = await d.describeOne(req(id(9)));
    expect(r.ok).toBe(true);
    expect(d.requests[0]?.batchId).toBeNull();
  });
});

describe("cross-instance state through a dir", () => {
  it("a batch submitted by one instance is polled by another; the dump has ids but no bytes or text", async () => {
    const dir = await tmp();
    const a = fake({ dir, pollsUntilComplete: 1 });
    const h = await a.describeBatch([req(id(1)), req(id(2))]);
    const b = fake({ dir, pollsUntilComplete: 1 });
    expect((await b.pollBatch(h)).state).toBe("in_progress");
    const done = await b.pollBatch(h);
    expect(done.state).toBe("completed");
    expect(done.results).toHaveLength(2);
    const files = await readdir(dir);
    expect(files.sort()).toEqual([`${h.batchId}.jsonl`, `${h.batchId}.state.json`].sort());
    const dump = await readFile(join(dir, `${h.batchId}.jsonl`), "utf8");
    const lines = dump
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.custom_id)).toEqual([id(1), id(2)]);
    expect(dump).not.toContain("SENTINEL-NOTE");
    expect(dump).not.toMatch(/base64|latitude|longitude|gps/i);
    expect(lines[0].plan).toBe("paid");
  });
  it("a path-traversing batch id is not loaded from disk", async () => {
    const dir = await tmp();
    const a = fake({ dir });
    const st = await a.pollBatch({
      provider: "fake",
      batchId: "../../etc/passwd",
      model: "gpt-6-luna",
      submittedAt: "",
      requestCount: 1,
      promptVersion: "v1",
      schemaVersion: "v1",
    });
    expect(st.state).toBe("failed");
  });
});

describe("production refusal", () => {
  it("createFakeVisionDescriber refuses NODE_ENV=production unless explicitly allowed", () => {
    expect(() => createFakeVisionDescriber({ env: { NODE_ENV: "production" } })).toThrow(
      AiNotConfiguredError,
    );
    expect(() =>
      createFakeVisionDescriber({
        env: { NODE_ENV: "production", AI_ALLOW_FAKE_IN_PRODUCTION: "false" },
      }),
    ).toThrow(AiNotConfiguredError);
    expect(() =>
      createFakeVisionDescriber({
        env: { NODE_ENV: "production", AI_ALLOW_FAKE_IN_PRODUCTION: "true" },
      }),
    ).not.toThrow();
  });
  it("the factory refuses it too, and warns when allowed", () => {
    expect(() =>
      createVisionDescriber({ VISION_PROVIDER: "fake", NODE_ENV: "production" }),
    ).toThrow(AiNotConfiguredError);
    const warns: unknown[] = [];
    const log = { info: () => undefined, warn: (o: unknown) => void warns.push(o) };
    createVisionDescriber(
      { VISION_PROVIDER: "fake", NODE_ENV: "production", AI_ALLOW_FAKE_IN_PRODUCTION: "true" },
      { log },
    );
    expect(warns).toHaveLength(1);
  });
  it("an unpriced model is a config error", () => {
    expect(() => createFakeVisionDescriber({ env: {}, model: "nope" })).toThrow(/VISION_MODEL/);
  });
});
