import { PHASH_NEAR_DUPLICATE_MAX_DISTANCE } from "@littlelight/shared";
import sharp from "sharp";

// Perceptual hash (docs/plans/step-4.md 2.7 step 10, D9; PRD FR-2.5 near-duplicates). In-house
// DCT pHash: greyscale 32×32, 2-D DCT-II, the 8×8 lowest-frequency AC block (u, v = 1..8: the
// DC row and column are skipped, which leaves exactly 64 coefficients), median threshold ⇒ a
// 64-character '0'/'1' string for Postgres `bit(64)`. Near-duplicate = Hamming distance
// ≤ PHASH_NEAR_DUPLICATE_MAX_DISTANCE, compared in SQL with `bit_count(a # b)`.

const N = 32;
const K = 8;

/** COS[k][x] = cos((2x + 1) kπ / 2N), for k = 1..K. */
const COS: Float64Array[] = Array.from({ length: K + 1 }, (_, k) => {
  const row = new Float64Array(N);
  for (let x = 0; x < N; x++) row[x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * N));
  return row;
});

/** pHash of a 32×32 greyscale matrix (row-major, length 1024). Exported for tests. */
export function phashFromGrey(grey: ArrayLike<number>): string {
  if (grey.length !== N * N) throw new RangeError("expected a 32x32 greyscale matrix");
  // Separable DCT restricted to u, v in 1..K: rows first, then columns.
  const rows = new Float64Array(N * K); // rows[y * K + (u - 1)]
  for (let y = 0; y < N; y++) {
    for (let u = 1; u <= K; u++) {
      const c = COS[u] as Float64Array;
      let sum = 0;
      for (let x = 0; x < N; x++) sum += (grey[y * N + x] as number) * (c[x] as number);
      rows[y * K + (u - 1)] = sum;
    }
  }
  const coeffs = new Float64Array(K * K); // coeffs[(v - 1) * K + (u - 1)]
  for (let v = 1; v <= K; v++) {
    const c = COS[v] as Float64Array;
    for (let u = 0; u < K; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += (rows[y * K + u] as number) * (c[y] as number);
      coeffs[(v - 1) * K + u] = sum;
    }
  }
  const sorted = Array.from(coeffs).sort((a, b) => a - b);
  const median = ((sorted[31] as number) + (sorted[32] as number)) / 2;
  let bits = "";
  for (const c of coeffs) bits += c > median ? "1" : "0";
  return bits;
}

/** pHash of an encoded image (any format sharp reads; the worker passes the JPEG thumb). */
export async function computePhash(image: Buffer): Promise<string> {
  const { data, info } = await sharp(image)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(N, N, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const grey = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) grey[i] = data[i * ch] as number;
  return phashFromGrey(grey);
}

/** Hamming distance of two 64-bit '0'/'1' strings. */
export function phashDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new RangeError("hash length mismatch");
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function isNearDuplicate(a: string, b: string): boolean {
  return phashDistance(a, b) <= PHASH_NEAR_DUPLICATE_MAX_DISTANCE;
}
