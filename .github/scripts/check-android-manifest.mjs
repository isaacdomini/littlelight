#!/usr/bin/env node
// Merged-manifest check for the Android debug build (docs/plans/step-9.md 9.3 "Done-when", 2.12,
// 2.14 "CI (9.16)"). Run after `./gradlew assembleDebug` by the CI android-debug job, and
// locally from the repo root:
//
//   node .github/scripts/check-android-manifest.mjs [variant]          (variant defaults to debug)
//
// Reads every AndroidManifest.xml AGP wrote for the variant under
// apps/mobile-web/android/app/build/intermediates/{merged_manifest,merged_manifests,
// packaged_manifests}/<variant>/ (the layout differs between AGP versions; at least one must
// exist) and fails when:
//   - any merged <uses-permission> / <uses-permission-sdk-23> is forbidden: the media, storage,
//     location and audio permissions the PRD's Photo Picker approach rules out (Play's
//     photo-permission policy), every permission the source manifest removes with
//     tools:node="remove" (so a plugin cannot merge one back in), and a few Play-sensitive
//     permissions this app has no use for;
//   - <application> does not set android:allowBackup="false" (tokens and the upload queue must
//     not reach Google backups, 2.12);
//   - android.permission.INTERNET is missing (sanity: proves the parse found the permissions).
// Only Node built-ins, so it runs without `pnpm install`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const variant = process.argv[2] ?? "debug";
const APP = "apps/mobile-web/android/app";
const SOURCE_MANIFEST = `${APP}/src/main/AndroidManifest.xml`;
const roots = ["merged_manifest", "merged_manifests", "packaged_manifests"].map((d) =>
  path.join(APP, "build/intermediates", d, variant),
);

/** Always forbidden, whatever the source manifest says. Matched against the full name. */
const FORBIDDEN = [
  /READ_MEDIA_/,
  /EXTERNAL_STORAGE/, // READ_, WRITE_, MANAGE_
  /ACCESS_MEDIA_LOCATION/,
  /_LOCATION$/, // ACCESS_FINE/COARSE/BACKGROUND_LOCATION
  /RECORD_AUDIO/,
  /QUERY_ALL_PACKAGES/,
  /READ_CONTACTS/,
  /READ_PHONE_STATE/,
  /SYSTEM_ALERT_WINDOW/,
  /REQUEST_INSTALL_PACKAGES/,
];

function findManifests(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findManifests(p));
    else if (name === "AndroidManifest.xml") out.push(p);
  }
  return out;
}

const permRe = /<uses-permission(?:-sdk-23)?\b[^>]*?android:name="([^"]+)"[^>]*>/g;
const permissionsOf = (xml) => [...xml.matchAll(permRe)].map((m) => m[1]);

const errors = [];

if (!existsSync(SOURCE_MANIFEST)) {
  console.error(`::error::${SOURCE_MANIFEST} is missing`);
  process.exit(1);
}
const removed = [...readFileSync(SOURCE_MANIFEST, "utf8").matchAll(permRe)]
  .filter((m) => /tools:node="remove"/.test(m[0]))
  .map((m) => m[1]);
if (removed.length === 0) {
  errors.push(`${SOURCE_MANIFEST}: no tools:node="remove" permissions (expected the 2.12 list)`);
}

const manifests = roots.flatMap(findManifests);
if (manifests.length === 0) {
  console.error(
    `::error::no merged manifest for variant "${variant}" under ${roots.join(", ")} (run ./gradlew assemble${variant[0].toUpperCase()}${variant.slice(1)} first)`,
  );
  process.exit(1);
}

for (const file of manifests) {
  const xml = readFileSync(file, "utf8");
  const perms = permissionsOf(xml);
  const bad = perms.filter((p) => removed.includes(p) || FORBIDDEN.some((re) => re.test(p)));
  for (const p of bad) errors.push(`${file}: forbidden permission ${p}`);
  if (!perms.includes("android.permission.INTERNET")) {
    errors.push(`${file}: android.permission.INTERNET not found (parse problem?)`);
  }
  const app = xml.match(/<application\b[^>]*>/)?.[0] ?? "";
  if (!/android:allowBackup="false"/.test(app)) {
    errors.push(`${file}: <application> does not set android:allowBackup="false"`);
  }
  console.log(`${file}: ${perms.length} permissions: ${perms.join(", ")}`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(
  `merged manifest OK (${manifests.length} files): none of ${removed.length} removed + ${FORBIDDEN.length} forbidden patterns, allowBackup=false`,
);
