import sharp from "sharp";

// Deterministic image fixtures (sharp-generated; no files, no people). Test-only.

/** mulberry32: a tiny seeded PRNG so fixtures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raw RGB noise, unique per seed. */
export function noiseRaw(width: number, height: number, seed: number): Buffer {
  const r = rng(seed);
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(r() * 256);
  return buf;
}

/** Structured "scene": large soft shapes that survive recompression; unique per `seed`. */
export async function sceneRaw(width: number, height: number, seed: number): Promise<Buffer> {
  const r = rng(seed);
  const shapes = Array.from({ length: 6 }, () => {
    const colour = `rgb(${Math.floor(r() * 256)},${Math.floor(r() * 256)},${Math.floor(r() * 256)})`;
    return `<circle cx="${Math.floor(r() * width)}" cy="${Math.floor(r() * height)}" r="${Math.floor(
      (0.1 + r() * 0.3) * Math.min(width, height),
    )}" fill="${colour}"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgb(${Math.floor(r() * 256)},${Math.floor(r() * 256)},40)"/>
      <stop offset="1" stop-color="rgb(20,${Math.floor(r() * 256)},${Math.floor(r() * 256)})"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>${shapes.join("")}</svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
}

export async function sceneJpeg(
  width: number,
  height: number,
  seed: number,
  quality = 90,
): Promise<Buffer> {
  return sharp(await sceneRaw(width, height, seed), { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}

export async function noiseJpeg(width: number, height: number, seed: number): Promise<Buffer> {
  return sharp(noiseRaw(width, height, seed), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function scenePng(width: number, height: number, seed: number): Promise<Buffer> {
  return sharp(await sceneRaw(width, height, seed), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

export async function sceneWebp(width: number, height: number, seed: number): Promise<Buffer> {
  return sharp(await sceneRaw(width, height, seed), { raw: { width, height, channels: 3 } })
    .webp({ quality: 85 })
    .toBuffer();
}

/** Semi-transparent PNG (flatten-onto-white test). */
export async function transparentPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

/** Bytes that start like an ISO-BMFF file of the given major brand (sniff tests only). */
export function ftypBuffer(brand: string): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "latin1");
  b.write(brand.padEnd(4, " ").slice(0, 4), 8, "latin1");
  b.write(brand.padEnd(4, " ").slice(0, 4), 16, "latin1");
  return b;
}
