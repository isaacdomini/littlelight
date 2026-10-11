// Frames every PNG in <in> with its caption into <out>, at the given store size.
//   tsx store-caption.ts <in> <out> <width> <height>
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { CAPTIONS, captionFrame } from "./store-frames";

const [inDir, outDir, w, h] = process.argv.slice(2);
if (!inDir || !outDir || !w || !h) throw new Error("usage: store-caption.ts <in> <out> <w> <h>");
for (const f of readdirSync(inDir)
  .filter((x) => x.endsWith(".png"))
  .sort()) {
  const key = f.replace(/^\d+-/, "").replace(/\.png$/, "");
  const caption = CAPTIONS[key];
  if (!caption) continue;
  const framed = await captionFrame(
    readFileSync(path.join(inDir, f)),
    caption,
    Number(w),
    Number(h),
  );
  await sharp(framed).toFile(path.join(outDir, f));
  console.log("  ", path.join(outDir, f));
}
