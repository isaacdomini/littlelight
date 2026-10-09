/**
 * Deterministic fake embedder (`VISION_PROVIDER=fake`; docs/plans/step-7.md 2.5). No network.
 *
 * `fakeEmbedding` is a hashed bag of words, so cosine similarity means "shares words": text is
 * lower-cased, split on anything that is not a letter or digit, stop words are dropped, words
 * get a light stemming (trailing `ing`, `ed`, `es`, `s`), and every unigram (weight 1.0) and
 * adjacent bigram (weight 0.5) is hashed (`sha256(feature)` → bucket index and sign) into `dims`
 * buckets; the vector is L2-normalised. cos("baby splashing in the bath", "bath time with the
 * yellow duck") > cos("baby splashing in the bath", "walking in the park"). It knows nothing of
 * synonyms or paraphrases: real semantic quality is only measured with the real model (plan 4.3).
 *
 * `fakeEmbeddingOpaque` is the step-6 behaviour (sha256-derived unit vector; identical text ⇔
 * identical vector, nothing else is similar), for tests that need exactly that.
 */

import { createHash } from "node:crypto";
import { DEFAULT_EMBED_MODEL } from "../defaults";
import { costUsd } from "../pricing";
import type { Embedder, EmbedResult } from "../types";

/** Stop words plus the filler of search queries ("show me photos of…"). */
export const FAKE_EMBED_STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her hers " +
    "him his how i if in into is it its me my of off on or our over she so than that the their " +
    "them then there these they this those to too up us very was we were what when where which " +
    "who why will with would you your " +
    "show find photo photos picture pictures pic pics please some any all"
  ).split(" "),
);

/** Light stemming: `splashing`→`splash`, `walked`→`walk`, `dresses`→`dress`, `steps`→`step`. */
export function fakeStem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && (word.endsWith("sses") || word.endsWith("xes") || word.endsWith("ches")))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Stemmed content words of `text`, in order (exported for tests and the fake chat model). */
export function fakeTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !FAKE_EMBED_STOP_WORDS.has(w))
    .map(fakeStem);
}

/** Bounded memo of feature → (bucket, sign); the vocabulary of the seed is small. */
const bucketCache = new Map<string, number>();
const BUCKET_CACHE_MAX = 200_000;

/** Signed bucket of a feature: `+(index + 1)` or `-(index + 1)`. */
function signedBucket(feature: string, dims: number): number {
  const key = `${dims}:${feature}`;
  const cached = bucketCache.get(key);
  if (cached !== undefined) return cached;
  const h = createHash("sha256").update(feature, "utf8").digest();
  const index = h.readUInt32BE(0) % dims;
  const value = (h[4] as number) & 1 ? -(index + 1) : index + 1;
  if (bucketCache.size >= BUCKET_CACHE_MAX) bucketCache.clear();
  bucketCache.set(key, value);
  return value;
}

/** Hashed bag-of-words embedding (unit length; see module doc). */
export function fakeEmbedding(text: string, dims: number): number[] {
  const tokens = fakeTokens(text);
  if (tokens.length === 0) return fakeEmbeddingOpaque(text, dims);
  const out: number[] = new Array(dims).fill(0);
  const add = (feature: string, weight: number) => {
    const b = signedBucket(feature, dims);
    const i = Math.abs(b) - 1;
    out[i] = (out[i] as number) + (b > 0 ? weight : -weight);
  };
  for (let i = 0; i < tokens.length; i++) {
    add(tokens[i] as string, 1);
    if (i > 0) add(`${tokens[i - 1]} ${tokens[i]}`, 0.5);
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return fakeEmbeddingOpaque(text, dims);
  return out.map((v) => v / norm);
}

/** Step-6 fake: unit vector derived from `sha256(text)`; identical texts ⇔ identical vectors. */
export function fakeEmbeddingOpaque(text: string, dims: number): number[] {
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

/** Cosine similarity of two equal-length vectors (tests, the bake-off and scratch checks). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** `ceil(chars / 4)`: the fake's token estimate. */
export function fakeTokenCount(texts: readonly string[]): number {
  return texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
}

export interface FakeEmbedderOptions {
  /** Default `fake` (so `photo_search.embed_model` reads `fake/1024`). */
  model?: string;
  dims: number;
  /** Priced like this model so the `ai_spend` ledger is non-zero (default `text-embedding-3-small`). */
  priceModel?: string;
}

export function createFakeEmbedder(opts: FakeEmbedderOptions): Embedder {
  const priceModel = opts.priceModel ?? DEFAULT_EMBED_MODEL;
  return {
    model: opts.model ?? "fake",
    dims: opts.dims,
    embed: async (texts): Promise<EmbedResult> => {
      const inputTokens = fakeTokenCount(texts);
      return {
        vectors: texts.map((t) => fakeEmbedding(t, opts.dims)),
        usage: {
          inputTokens,
          costUsd: costUsd(priceModel, "standard", {
            inputTokens,
            cachedInputTokens: 0,
            outputTokens: 0,
          }),
        },
      };
    },
  };
}
