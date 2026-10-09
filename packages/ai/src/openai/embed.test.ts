import { afterEach, describe, expect, it } from "vitest";
import { AiProviderError } from "../errors";
import { fakeEmbedding } from "../fake/embed";
import { createEmbedder } from "../index";
import { startMockServer } from "../testing/mock-http";
import { startOpenAiMockServer } from "../testing/openai-mock-server";
import { createOpenAiEmbedder } from "./embed";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
});

describe("OpenAI embedder", () => {
  it("returns one 1024-dim vector per input in input order (server answers in reverse)", async () => {
    const mock = await startOpenAiMockServer();
    closers.push(mock.close);
    const e = createOpenAiEmbedder({
      apiKey: "k",
      model: "text-embedding-3-small",
      dims: 1024,
      baseUrl: mock.baseUrl,
    });
    const out = await e.embed(["alpha", "beta", "gamma"]);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v.length === 1024)).toBe(true);
    expect(out[0]).toEqual(fakeEmbedding("alpha", 1024));
    expect(out[2]).toEqual(fakeEmbedding("gamma", 1024));
    expect(mock.requests[0]?.body).toMatchObject({
      model: "text-embedding-3-small",
      dimensions: 1024,
      encoding_format: "float",
      input: ["alpha", "beta", "gamma"],
    });
    expect(e.dims).toBe(1024);
  });

  it("rejects a wrong dimension or count with a code, not the vectors", async () => {
    const bad = await startMockServer(() => ({
      status: 200,
      json: { data: [{ index: 0, embedding: [1, 2, 3] }] },
    }));
    closers.push(bad.close);
    const e = createOpenAiEmbedder({ apiKey: "k", model: "m", dims: 1024, baseUrl: bad.baseUrl });
    const err = await e.embed(["a"]).catch((x) => x);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("malformed_embeddings");
    await expect(e.embed(["a", "b"])).rejects.toBeInstanceOf(AiProviderError);
  });

  it("factory: fake provider gives fake embedder with EMBED_DIMS; openai needs the OpenAI key", async () => {
    const f = createEmbedder({ VISION_PROVIDER: "fake" });
    expect(f.dims).toBe(1024);
    expect((await f.embed(["x"]))[0]).toHaveLength(1024);
    expect(() => createEmbedder({ VISION_PROVIDER: "fake", EMBED_DIMS: "256" }).dims).not.toThrow();
  });
});
