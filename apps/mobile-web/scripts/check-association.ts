// Prints which placeholders remain in the app-association files. Warning only: it never fails
// the web build (docs/plans/step-9.md 2.4). Run: pnpm --filter @littlelight/mobile-web exec tsx scripts/check-association.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", ".well-known");
const placeholders = ["APPLE_TEAM_ID", "PLAY_APP_SIGNING_SHA256", "UPLOAD_KEY_SHA256"];
const files = ["apple-app-site-association", "assetlinks.json"];

let remaining = 0;
for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8");
  JSON.parse(text); // must stay valid JSON
  for (const p of placeholders) {
    if (text.includes(p)) {
      remaining += 1;
      console.warn(`warning: ${file} still contains placeholder ${p}`);
    }
  }
}
if (remaining === 0) console.log("association files have no placeholders left");
process.exit(0);
