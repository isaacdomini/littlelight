/**
 * Deterministic fake embedder (`VISION_PROVIDER=fake`; step 7 tests): unit vectors derived from
 * `sha256(text)`; identical texts give identical vectors. No network.
 */

import { createHash } from "node:crypto";
import type { Embedder } from "../types";

export function fakeEmbedding(text: string, dims: number): number[] {
  const out: number[] = new Array(dims);
  let block = createHash("sha256").update(text, "utf8").digest();
  let i = 0;
  let counter = 0;
  while (i < dims) {
    for (let b = 0; b + 1 < block.length && i < dims; b += 2) {
      out[i++] = ((((block[b] ?? 0) << 8) | (block[b + 1] ?? 0)) / 65535) * 2 - 1;
    }
    counter++;
    block = createHash("sha256").update(block).update(String(counter)).digest();
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

export function createFakeEmbedder(opts: { model: string; dims: number }): Embedder {
  return {
    model: opts.model,
    dims: opts.dims,
    embed: async (texts) => texts.map((t) => fakeEmbedding(t, opts.dims)),
  };
}
