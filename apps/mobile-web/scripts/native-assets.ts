/**
 * Regenerates every native icon and splash image from `resources/*.svg` (docs/plans/step-9.md 2.12).
 * Deterministic: running it twice produces byte-identical files.
 *
 *   pnpm --filter @tinyglow/mobile-web native:assets
 *
 * Writes into ios/App/App/Assets.xcassets and android/app/src/main/res, plus the Play Store icon
 * under fastlane/metadata/android/en-US/images/. Native sources are plain files; nothing here runs
 * at build time.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = (name: string): Buffer => readFileSync(join(root, "resources", name));
const iosAssets = join(root, "ios/App/App/Assets.xcassets");
const androidRes = join(root, "android/app/src/main/res");

const png = { compressionLevel: 9, adaptiveFiltering: false, effort: 10 } as const;

const written: string[] = [];
function out(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  written.push(path.replace(`${root}/`, ""));
}

const raster = (svg: Buffer, size: number): sharp.Sharp =>
  sharp(svg, { density: 288 }).resize(size, size);

async function iosIcon(svg: string, grey = false): Promise<Buffer> {
  // App Store icons must be opaque: flatten and drop alpha.
  let img = raster(res(svg), 1024).flatten({ background: "#000000" }).removeAlpha();
  if (grey) img = img.greyscale();
  return img.png(png).toBuffer();
}

async function splash(markSvg: string, background: string): Promise<Buffer> {
  const mark = await raster(res(markSvg), 900).png(png).toBuffer();
  return sharp({ create: { width: 2732, height: 2732, channels: 3, background } })
    .composite([{ input: mark, gravity: "centre" }])
    .png(png)
    .toBuffer();
}

async function ios(): Promise<void> {
  const icons = join(iosAssets, "AppIcon.appiconset");
  rmSync(join(icons, "AppIcon-512@2x.png"), { force: true });
  out(join(icons, "AppIcon-1024.png"), await iosIcon("icon.svg"));
  out(join(icons, "AppIcon-dark-1024.png"), await iosIcon("icon-dark.svg"));
  out(join(icons, "AppIcon-tinted-1024.png"), await iosIcon("icon-tinted.svg", true));
  const entry = (filename: string, value?: string) => ({
    ...(value ? { appearances: [{ appearance: "luminosity", value }] } : {}),
    filename,
    idiom: "universal",
    platform: "ios",
    size: "1024x1024",
  });
  out(
    join(icons, "Contents.json"),
    `${JSON.stringify(
      {
        images: [
          entry("AppIcon-1024.png"),
          entry("AppIcon-dark-1024.png", "dark"),
          entry("AppIcon-tinted-1024.png", "tinted"),
        ],
        info: { author: "xcode", version: 1 },
      },
      null,
      2,
    )}\n`,
  );

  const sp = join(iosAssets, "Splash.imageset");
  for (const old of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    rmSync(join(sp, old), { force: true });
  }
  out(join(sp, "splash-light.png"), await splash("splash-mark.svg", "#FFFFFF"));
  out(join(sp, "splash-dark.png"), await splash("splash-mark-dark.svg", "#0E0F11"));
  out(
    join(sp, "Contents.json"),
    `${JSON.stringify(
      {
        images: [
          { idiom: "universal", filename: "splash-light.png" },
          {
            appearances: [{ appearance: "luminosity", value: "dark" }],
            idiom: "universal",
            filename: "splash-dark.png",
          },
        ],
        info: { author: "xcode", version: 1 },
      },
      null,
      2,
    )}\n`,
  );
}

const densities = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
] as const;

function legacyMask(shape: "round" | "square", size: number): Buffer {
  const r = shape === "round" ? size / 2 : size * 0.22;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`,
  );
}

async function android(): Promise<void> {
  const fg = res("icon-foreground.svg");
  for (const [d, scale] of densities) {
    const dir = join(androidRes, `mipmap-${d}`);
    const legacy = Math.round(48 * scale);
    const adaptive = Math.round(108 * scale);
    for (const [name, shape] of [
      ["ic_launcher.png", "square"],
      ["ic_launcher_round.png", "round"],
    ] as const) {
      out(
        join(dir, name),
        await raster(res("icon.svg"), legacy)
          .composite([{ input: legacyMask(shape, legacy), blend: "dest-in" }])
          .png(png)
          .toBuffer(),
      );
    }
    // Adaptive layers are 108dp with the mark inside the central 66dp safe zone (it is: 58% wide).
    const layer = await raster(fg, adaptive).png(png).toBuffer();
    out(join(dir, "ic_launcher_foreground.png"), layer);
    // Themed icon: only the alpha channel matters; the system tints it.
    out(join(dir, "ic_launcher_monochrome.png"), layer);

    const stat = Math.round(24 * scale);
    out(
      join(androidRes, `drawable-${d}`, "ic_stat_tinyglow.png"),
      await raster(res("notification.svg"), stat).png(png).toBuffer(),
    );
  }

  out(join(androidRes, "mipmap-anydpi-v26/ic_launcher.xml"), adaptiveXml());
  out(join(androidRes, "mipmap-anydpi-v26/ic_launcher_round.xml"), adaptiveXml());

  // Android 12+ splash icon (transparent, centred in the system circle) per theme.
  for (const [dir, svg] of [
    ["drawable-nodpi", "splash-mark.svg"],
    ["drawable-night-nodpi", "splash-mark-dark.svg"],
  ] as const) {
    out(join(androidRes, dir, "splash_icon.png"), await raster(res(svg), 960).png(png).toBuffer());
  }

  // Template artwork that the new resources replace.
  for (const d of [
    "",
    "-v24",
    "-port-mdpi",
    "-port-hdpi",
    "-port-xhdpi",
    "-port-xxhdpi",
    "-port-xxxhdpi",
    "-land-mdpi",
    "-land-hdpi",
    "-land-xhdpi",
    "-land-xxhdpi",
    "-land-xxxhdpi",
  ]) {
    for (const f of ["splash.png", "ic_launcher_background.xml", "ic_launcher_foreground.xml"]) {
      rmSync(join(androidRes, `drawable${d}`, f), { force: true });
    }
  }

  // Play Store listing icon (512 px, opaque).
  out(
    join(root, "fastlane/metadata/android/en-US/images/icon.png"),
    await raster(res("icon.svg"), 512)
      .flatten({ background: "#E8836B" })
      .removeAlpha()
      .png(png)
      .toBuffer(),
  );
}

function adaptiveXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
}

await ios();
await android();
console.log(`native:assets wrote ${written.length} files`);
