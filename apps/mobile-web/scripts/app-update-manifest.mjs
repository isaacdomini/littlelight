#!/usr/bin/env node
// Live-update manifest generator (docs/plans/step-14.md 2.4, task 14.4).
//
//   node scripts/app-update-manifest.mjs <distDir>
//
// Walks <distDir>, records sha256 + size for every file (sorted by path), skips the excluded
// prefixes, derives the content id (`version`) and writes <distDir>/app-update/manifest.json.
// `webVersion` and `minNativeBuild` come from apps/mobile-web/app-update.json.
//
// Plain Node ESM on purpose: the web image's build stage runs it without tsx. The exclude list
// and the content id algorithm mirror `APP_UPDATE_EXCLUDE_PREFIXES` / `appUpdateContentId` in
// packages/shared/src/app-update.ts; a unit test asserts they agree.
//
// Deterministic for a given dist: `builtAt` is the only non-content field and the content id
// ignores it. Set SOURCE_DATE_EPOCH (seconds) to pin `builtAt` as well.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA = 1;
export const MANIFEST_PATH = "app-update/manifest.json";
export const EXCLUDE_PREFIXES = ["app-update/", ".well-known/", "email-templates/"];
const MAX_FILES = 2_000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** Code-unit order: stable across locales and identical to a plain `<` comparison. */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** sha256(sorted `${path}\n${sha256}\n` lines).slice(0, 16), same as the shared function. */
export function contentId(files) {
  const lines = [...files]
    .sort(byPath)
    .map((f) => `${f.path}\n${f.sha256}\n`)
    .join("");
  return sha256Hex(Buffer.from(lines, "utf8")).slice(0, 16);
}

function walk(root, rel, out) {
  const entries = readdirSync(join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDE_PREFIXES.some((p) => `${path}/`.startsWith(p))) continue;
      walk(root, path, out);
    } else if (entry.isFile()) {
      if (EXCLUDE_PREFIXES.some((p) => path.startsWith(p))) continue;
      out.push(path);
    } else {
      // Symlinks, sockets, etc.: the phone stages plain files only.
      throw new Error(`app-update-manifest: unsupported entry type at ${path}`);
    }
  }
}

export function collectFiles(distDir) {
  const paths = [];
  walk(distDir, "", paths);
  const files = paths.map((path) => {
    const bytes = readFileSync(join(distDir, path));
    return { path, sha256: sha256Hex(bytes), size: bytes.length };
  });
  return files.sort(byPath);
}

function readConfig(configPath) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const { webVersion, minNativeBuild } = raw ?? {};
  if (typeof webVersion !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(webVersion)) {
    throw new Error("app-update.json: webVersion must match /^[0-9A-Za-z.+-]{1,32}$/");
  }
  for (const platform of ["ios", "android"]) {
    const n = minNativeBuild?.[platform];
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`app-update.json: minNativeBuild.${platform} must be an integer >= 1`);
    }
  }
  return {
    webVersion,
    minNativeBuild: { ios: minNativeBuild.ios, android: minNativeBuild.android },
  };
}

function builtAtIso() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

export function buildManifest(distDir, config) {
  const files = collectFiles(distDir);
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error("app-update-manifest: index.html missing from dist");
  }
  if (files.length > MAX_FILES) {
    throw new Error(`app-update-manifest: ${files.length} files exceeds ${MAX_FILES}`);
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_BUNDLE_BYTES) {
    throw new Error(`app-update-manifest: bundle is ${total} bytes, limit ${MAX_BUNDLE_BYTES}`);
  }
  return {
    schema: MANIFEST_SCHEMA,
    version: contentId(files),
    webVersion: config.webVersion,
    minNativeBuild: config.minNativeBuild,
    builtAt: builtAtIso(),
    files,
  };
}

function main(argv) {
  const distArg = argv[2];
  if (!distArg) {
    console.error("usage: node scripts/app-update-manifest.mjs <distDir>");
    process.exit(2);
  }
  const distDir = resolve(distArg);
  if (!statSync(distDir).isDirectory()) throw new Error(`${distDir} is not a directory`);
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app-update.json");
  const manifest = buildManifest(distDir, readConfig(configPath));
  const out = join(distDir, MANIFEST_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `app-update manifest: version ${manifest.version}, ${manifest.files.length} files, web ${manifest.webVersion}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
