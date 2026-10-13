#!/usr/bin/env node
// Live-update manifest check (docs/plans/step-14.md 2.5, 2.9 "images", 4.2; task 14.11). Called
// by .github/scripts/check-web-app-update.sh against a running web image, or on its own against a
// local build:
//
//   node .github/scripts/check-web-app-update.mjs --base-url http://127.0.0.1:18081
//   node .github/scripts/check-web-app-update.mjs --dist apps/mobile-web/dist
//
// Reads app-update/manifest.json (over HTTP, or from <dist>) and asserts, with the same rules as
// appUpdateManifestSchema / appUpdateContentId in packages/shared/src/app-update.ts (re-stated
// here so the check needs no install):
//   - schema 1; version 16 lowercase hex; webVersion /^[0-9A-Za-z.+-]{1,32}$/; minNativeBuild.ios
//     and .android integers >= 1; builtAt an ISO date-time;
//   - 1..2000 files, each { path, sha256 (64 hex), size (int >= 0) }; paths unique, relative,
//     no `..` segment, no NUL; index.html listed; nothing under app-update/, .well-known/ or
//     email-templates/; summed size <= 64 MiB;
//   - version == sha256(files sorted by path (code-unit order) as "path\nsha256\n")[0..16];
//   - every listed file exists (HTTP: fetched with Accept-Encoding: identity, status 200) and
//     its bytes have exactly that sha256 and size.
// With --expect-text <s> (HTTP or dist), at least one listed .js file contains <s> (VITE_API_URL
// baked into the bundle, D10). Prints counts and the content id only. Only Node built-ins.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let baseUrl = null;
let dist = null;
let expectText = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base-url" && args[i + 1]) baseUrl = args[++i].replace(/\/+$/, "");
  else if (args[i] === "--dist" && args[i + 1]) dist = path.resolve(args[++i]);
  else if (args[i] === "--expect-text" && args[i + 1]) expectText = args[++i];
  else usage();
}
if ((baseUrl === null) === (dist === null)) usage();
function usage() {
  console.error(
    "usage: check-web-app-update.mjs (--base-url <url> | --dist <dir>) [--expect-text <s>]",
  );
  process.exit(2);
}

const MANIFEST_PATH = "app-update/manifest.json";
const EXCLUDE = ["app-update/", ".well-known/", "email-templates/"];
const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;
const errors = [];
const err = (m) => errors.push(m);

async function get(rel) {
  if (dist) return { status: 200, bytes: readFileSync(path.join(dist, rel)) };
  const res = await fetch(`${baseUrl}/${rel.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { "Accept-Encoding": "identity" },
    redirect: "manual",
  });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

let manifest;
try {
  const r = await get(MANIFEST_PATH);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  manifest = JSON.parse(r.bytes.toString("utf8"));
} catch (e) {
  console.error(`::error::${MANIFEST_PATH} could not be read as JSON (${e.code ?? e.message})`);
  process.exit(1);
}

if (manifest.schema !== 1) err("schema is not 1");
if (typeof manifest.version !== "string" || !/^[0-9a-f]{16}$/.test(manifest.version))
  err("version is not 16 lowercase hex");
if (typeof manifest.webVersion !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(manifest.webVersion))
  err("webVersion invalid");
for (const p of ["ios", "android"]) {
  const v = manifest.minNativeBuild?.[p];
  if (!Number.isInteger(v) || v < 1) err(`minNativeBuild.${p} is not an integer >= 1`);
}
if (
  typeof manifest.builtAt !== "string" ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.builtAt) ||
  Number.isNaN(Date.parse(manifest.builtAt))
)
  err("builtAt is not an ISO date-time");

const files = Array.isArray(manifest.files) ? manifest.files : [];
if (!Array.isArray(manifest.files)) err("files is not an array");
if (files.length < 1 || files.length > MAX_FILES)
  err(`files has ${files.length} entries (1..${MAX_FILES})`);
const seen = new Set();
let total = 0;
let valid = true;
for (const [i, f] of files.entries()) {
  const p = f?.path;
  const bad = (m) => {
    err(`files[${i}]: ${m}`);
    valid = false;
  };
  if (typeof p !== "string" || p.length < 1 || p.length > 512) {
    bad("path missing or too long");
    continue;
  }
  if (p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || p.includes("\u0000"))
    bad("path not relative or has '..'/NUL");
  if (seen.has(p)) bad("duplicate path");
  seen.add(p);
  if (EXCLUDE.some((x) => p.startsWith(x)))
    bad(`path under an excluded prefix (${EXCLUDE.find((x) => p.startsWith(x))})`);
  if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))
    bad("sha256 not 64 lowercase hex");
  if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_BYTES) bad("size invalid");
  else total += f.size;
}
if (!seen.has("index.html")) err("index.html is not listed");
if (total > MAX_BYTES) err(`summed size ${total} > ${MAX_BYTES}`);

if (valid && files.length) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const id = createHash("sha256")
    .update(sorted.map((f) => `${f.path}\n${f.sha256}\n`).join(""), "utf8")
    .digest("hex")
    .slice(0, 16);
  if (id !== manifest.version) err("version is not the content id of the listed files");
}

let fetched = 0;
let foundText = expectText === null;
if (valid) {
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      let r;
      try {
        r = await get(f.path);
      } catch (e) {
        err(`${f.path}: not readable (${e.code ?? e.message})`);
        continue;
      }
      if (r.status !== 200) {
        err(`${f.path}: HTTP ${r.status}`);
        continue;
      }
      fetched++;
      if (r.bytes.length !== f.size) err(`${f.path}: size ${r.bytes.length} != manifest ${f.size}`);
      if (createHash("sha256").update(r.bytes).digest("hex") !== f.sha256)
        err(`${f.path}: sha256 mismatch`);
      if (!foundText && f.path.endsWith(".js") && r.bytes.includes(expectText)) foundText = true;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}
if (!foundText) err("no listed .js file contains the expected text (VITE_API_URL not baked?)");

if (errors.length) {
  for (const e of errors.slice(0, 40)) console.error(`  ${e}`);
  console.error(`::error::app-update manifest check failed (${errors.length} problem(s) above)`);
  process.exit(1);
}
console.log(
  `manifest ok (schema 1, ${files.length} files, ${total} bytes, version ${manifest.version}), index.html listed, nothing under ${EXCLUDE.join(" / ")}, every file sha256+size match (${fetched} read)${expectText !== null ? ", VITE_API_URL baked" : ""}`,
);
