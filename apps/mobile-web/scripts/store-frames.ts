// Shared helpers for the store assets: the caption frame and the Play feature graphic.
// Brand colours and the system font stack come from docs/DESIGN.md. No external assets.
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const CORAL = "#E8836B"; // UI accent: caption frame stays coral
const FONT =
  "-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica, Roboto, Arial, sans-serif";

const NIGHT = "#1F1A2E";
const brandFile = (name: string): Buffer =>
  readFileSync(path.resolve(import.meta.dirname, "../../../brand/logo", name));

/**
 * Play feature graphic (1024 x 500): the approved glowing mark (brand/logo/mark.svg) and the white
 * wordmark (brand/logo/wordmark-white.svg, outlined paths) on night purple, plus the tagline.
 */
export async function featureGraphic(): Promise<Buffer> {
  const markPx = 400;
  const mark = await sharp(brandFile("mark.svg"), { density: 288 })
    .resize(markPx, markPx)
    .png()
    .toBuffer();
  const word = await sharp(brandFile("wordmark-white.svg"), { density: 288 })
    .resize({ width: 420 })
    .png()
    .toBuffer();
  const wordH = (await sharp(word).metadata()).height ?? 100;
  const wordTop = 150;
  const tag = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="110">
  <text x="4" y="34" font-family="${FONT}" font-size="31" fill="#FFFFFF" fill-opacity="0.92">A private, searchable photo album</text>
  <text x="4" y="82" font-family="${FONT}" font-size="31" fill="#FFFFFF" fill-opacity="0.92">for your baby.</text>
</svg>`);
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">
  <rect width="1024" height="500" fill="${NIGHT}"/></svg>`);
  return sharp(bg)
    .composite([
      { input: mark, left: 580, top: 50 },
      { input: word, left: 76, top: wordTop },
      { input: tag, left: 76, top: wordTop + wordH + 28 },
    ])
    .png()
    .toBuffer();
}

/** A framed store image: warm background, caption on top, the screenshot below with rounded corners. */
export async function captionFrame(
  shot: Buffer,
  caption: string,
  W: number,
  H: number,
): Promise<Buffer> {
  const capH = Math.round(H * 0.15);
  const margin = Math.round(W * 0.07);
  const shotW = W - margin * 2;
  const scaled = await sharp(shot).resize({ width: shotW }).png().toBuffer();
  const meta = await sharp(scaled).metadata();
  const visibleH = H - capH - margin; // the phone runs off the bottom edge
  const radius = Math.round(W * 0.06);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${shotW}" height="${meta.height}"><rect width="${shotW}" height="${meta.height}" rx="${radius}" fill="#fff"/></svg>`,
  );
  const masked = await sharp(scaled)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const rounded = await sharp(masked)
    .extract({ left: 0, top: 0, width: shotW, height: Math.min(meta.height ?? visibleH, visibleH) })
    .png()
    .toBuffer();
  const fs = Math.round(Math.min(W * 0.065, (W * 0.86) / (caption.length * 0.56)));
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#FBEFEA"/>
    <rect x="${W / 2 - W * 0.04}" y="${Math.round(capH * 0.2)}" width="${W * 0.08}" height="${Math.round(W * 0.01)}" rx="${W * 0.005}" fill="${CORAL}"/>
    <text x="${W / 2}" y="${Math.round(capH * 0.62)}" text-anchor="middle" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="#1B1C1F">${caption.replace(/&/g, "&amp;")}</text>
  </svg>`);
  return sharp(bg)
    .composite([{ input: rounded, left: margin, top: capH }])
    .png()
    .toBuffer();
}

/** Captions by screen name (file name without the number). No pricing, no plan names. */
export const CAPTIONS: Record<string, string> = {
  timeline: "Every moment, in order",
  viewer: "Details saved with every photo",
  milestones: "Milestones, remembered",
  family: "Share with the people you choose",
  upload: "Add photos in a tap",
  chat: "Ask about any memory",
  growth: "Watch them grow",
  "album-sync": "Bring in a photo album",
};
