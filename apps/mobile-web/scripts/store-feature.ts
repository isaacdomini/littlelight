// Regenerates only the Play feature graphic (1024x500) from brand/logo. No browser, no stack needed.
//   pnpm --filter @tinyglow/mobile-web exec tsx scripts/store-feature.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { featureGraphic } from "./store-frames";

const dir = path.resolve(import.meta.dirname, "../fastlane/metadata/android/en-US/images");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "featureGraphic.png"), await featureGraphic());
console.log("wrote fastlane/metadata/android/en-US/images/featureGraphic.png");
