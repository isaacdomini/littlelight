#!/usr/bin/env node
// Photo-import hygiene, static part (docs/plans/step-10.md 2.6, 2.7, 2.9, 2.10 "CI (10.14)", D6,
// R5; task 10.14). Run by .github/scripts/import-hygiene.sh (which adds the runtime and git-drift
// checks) and runnable on its own from the repo root:
//
//   node .github/scripts/import-hygiene.mjs [--root <dir>]
//
// Scope ("import code"): non-test sources under apps/api/src/imports and apps/worker/src/import,
// plus apps/mobile-web/src/platform/native/photoSync.ts and the iOS TinyglowPhotoSync.swift.
//
//  1. Logging. No `console.*` call in the import code. Every logger call (`log.info(`,
//     `request.log.warn(`, `deps.log.error(`, `logger.child(` ...) has arguments that hold none
//     of: baseUrl, pickerUri, mediaDownloadUrl, refresh_token, access_token, refreshToken,
//     accessToken, idToken, authorization, client_secret / clientSecret (anywhere, keys included),
//     nor a bare value of token(s), code, state, grant, creds, url, href, uri, location, headers
//     (as a value: `{ code }`, `{ x: state }`, `${url}`; object keys, property reads such as
//     `err.code`, comparisons `code === "…"` and `.length` are fine), nor a raw error object
//     (`{ err }`, `err: e`, `log.warn(err, …)`: errors are logged as a category). String
//     literals are ignored (message text is fixed); template interpolations are checked. Each
//     of the api and worker import folders must contain at least one logger call (non-vacuous).
//     TinyglowPhotoSync.swift has no print / debugPrint / dump / NSLog / os_log / Logger(.
//  2. The worker never reads `google_accounts`: no `google_accounts`, `refresh_token_enc`,
//     `decrypt_secret`, `service_role` or `withServiceRole` in any non-test apps/worker/src code
//     (SQL strings included, comments excluded); the token comes only from
//     `import_google_refresh_token(` (must be used in apps/worker/src/import). No migration grants
//     anything on google_accounts to `pipeline` / `tinyglow_worker`, and the bootstrap grants
//     the worker login role `pipeline` only (never service_role).
//  3. The worker never inserts into `photos`: no `INSERT INTO [public.]photos` (across line
//     breaks), `insertInto("photos")` or `COPY photos` in apps/worker/src/import; photos are
//     booked only through `import_book_photo(` (must be used). No migration grants INSERT (or
//     ALL) on photos to `pipeline` / `tinyglow_worker`.
//  4. The SSRF guard runs before every media fetch (D6, R5):
//     a. every `mediaDownloadUrl(` / `googleMediaDownloadUrl(` call (the URL builders; step 12
//        added the photo/video one, `=d` / `=dv`) in the import code is the direct argument of
//        `parseAllowedMediaUrl(` or `isAllowedMediaUrl(` (at least one such call must exist);
//     b. no request call (fetch, fetchImpl, once, withRetry, request, got, http(s).get) in the
//        import code has an argument that names baseUrl / baseUrls / mediaFile /
//        mediaDownloadUrl / googleMediaDownloadUrl: media bytes are fetched only by downloadMedia();
//     c. in apps/worker/src/import/google/download.ts every request call's URL argument is a
//        variable (or its `.href`) assigned only from guarded values: results of
//        `parseAllowedMediaUrl(` / `resolveMediaRedirect(` that are null-checked with a throw
//        (`if (!x) throw …`) right after, and each such call passes `redirect: "manual"`;
//     d. handler.ts downloads through `downloadMedia(` (non-vacuous), and no import code sets
//        `redirect: "follow"`.
//  5. The fake is refused in production, statically: packages/shared/src/env.ts refines
//     `GOOGLE_IMPORT_PROVIDER === "fake"` against `NODE_ENV === "production"`, apps/api and
//     apps/worker config.ts compose `googleImportEnvSchema`, fake-server.ts refuses
//     `production` in both the library and the CLI, and docker-compose.yml has no google-fake
//     service and no `GOOGLE_IMPORT_PROVIDER:-fake` default. (import-hygiene.sh then proves the
//     refusals at runtime.)
//  6. GOOGLE_IMPORT_CLIENT_SECRET never appears in apps/mobile-web (outside node_modules / build
//     output), packages/shared/src/api or docker/ (web image); no VITE_GOOGLE_IMPORT_* variable.
//
//
// `--drift <base>` runs only the step-10 scope checks against a git base commit (CI and the step-10
// gate use 10c3d55, the steps 12 + 13 commit: step 12's video frames changed packages/ai on
// purpose; docs/plans/step-10.md 4.1 names an older commit, superseded):
//  D1. No AI-path change: `git diff <base>` and untracked files under packages/ai,
//      apps/worker/src/ai, apps/api/src/chat and apps/api/src/search are empty.
//  D2. `@capacitor/browser` is the only new dependency: the dependency names of every
//      package.json (dependencies, devDependencies, optionalDependencies, peerDependencies) and
//      of every pnpm-lock.yaml importer, now vs <base>; any other new name fails. Later steps
//      that intentionally add a dependency or touch the AI path move the base (import-hygiene.sh
//      IMPORT_DRIFT_BASE) in the same commit.
//
// Every path the checks read must exist, so a move or rename fails instead of passing silently.
// `--root` points the checks at a copy of the tree (negative tests: copy, plant a violation, see
// it fail). Prints locations and rule names only. Only Node built-ins.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let root = process.cwd();
let driftBase = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) root = path.resolve(args[++i]);
  else if (args[i] === "--drift" && args[i + 1]) driftBase = args[++i];
  else {
    console.error("usage: import-hygiene.mjs [--root <dir>] [--drift <base-commit>]");
    process.exit(2);
  }
}

let failed = false;
const ok = (what) => console.log(`ok: ${what}`);
function report(what, hits) {
  if (hits.length === 0) {
    ok(what);
    return;
  }
  for (const h of hits.slice(0, 40)) console.error(`  ${h}`);
  if (hits.length > 40) console.error(`  … ${hits.length - 40} more`);
  console.error(`::error::${what} (${hits.length} violation(s) above)`);
  failed = true;
}

const abs = (rel) => path.join(root, rel);
const exists = (rel) => {
  try {
    statSync(abs(rel));
    return true;
  } catch {
    return false;
  }
};
const read = (rel) => readFileSync(abs(rel), "utf8");

if (driftBase !== null) {
  runDrift(driftBase);
  process.exit(failed ? 1 : 0);
}

function git(...a) {
  return execFileSync("git", ["-C", root, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Dependency names of a package.json text. */
function manifestDeps(text) {
  const names = new Set();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const n of Object.keys(json[field] ?? {})) names.add(n);
  }
  return names;
}

/** Dependency names of every importer in a pnpm-lock.yaml (all YAML documents). */
function lockfileDeps(text) {
  const names = new Set();
  let inImporters = false;
  let inGroup = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith("importers:");
      inGroup = false;
      continue;
    }
    if (!inImporters) continue;
    const group = /^ {4}(\w+):/.exec(line);
    if (group) {
      inGroup = ["dependencies", "devDependencies", "optionalDependencies"].includes(group[1]);
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      inGroup = false;
      continue;
    }
    const dep = inGroup && /^ {6}(['"]?)([^'"\s]+)\1:\s*$/.exec(line);
    if (dep) names.add(dep[2]);
  }
  return names;
}

function runDrift(base) {
  const ALLOWED_NEW = new Set(["@capacitor/browser"]);
  const AI_PATHS = [
    "packages/ai",
    "apps/worker/src/ai",
    "apps/api/src/chat",
    "apps/api/src/search",
  ];
  let baseSha;
  try {
    baseSha = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).trim();
  } catch {
    console.error(
      `::error::drift base ${base} is not in this clone (CI: actions/checkout needs fetch-depth: 0)`,
    );
    failed = true;
    return;
  }
  console.log(`drift base: ${base} (${baseSha.slice(0, 12)})`);

  // D1
  {
    const missingPaths = AI_PATHS.filter((p) => !exists(p));
    const changed = git("diff", "--name-status", baseSha, "--", ...AI_PATHS)
      .split("\n")
      .filter(Boolean);
    const untracked = git("ls-files", "-o", "--exclude-standard", "--", ...AI_PATHS)
      .split("\n")
      .filter(Boolean)
      .map((f) => `??\t${f}`);
    report(`no change under ${AI_PATHS.join(", ")} since ${base}`, [
      ...missingPaths.map((p) => `${p} is missing`),
      ...changed,
      ...untracked,
    ]);
  }

  // D2
  {
    const hits = [];
    const isManifest = (f) =>
      (f === "package.json" || f.endsWith("/package.json")) &&
      !f.split("/").includes("node_modules");
    const baseFiles = git("ls-tree", "-r", "--name-only", baseSha).split("\n").filter(isManifest);
    const nowFiles = git("ls-files", "-co", "--exclude-standard").split("\n").filter(isManifest);
    const baseNames = new Set();
    for (const f of baseFiles) {
      const deps = manifestDeps(git("show", `${baseSha}:${f}`));
      if (deps === null) hits.push(`${base}:${f}: not valid JSON`);
      else for (const n of deps) baseNames.add(n);
    }
    const added = new Map();
    for (const f of nowFiles) {
      if (!exists(f)) continue;
      const deps = manifestDeps(read(f));
      if (deps === null) {
        hits.push(`${f}: not valid JSON`);
        continue;
      }
      for (const n of deps) {
        if (!baseNames.has(n)) added.set(n, [...(added.get(n) ?? []), f]);
      }
    }
    const baseLock = lockfileDeps(git("show", `${baseSha}:pnpm-lock.yaml`));
    const nowLock = lockfileDeps(read("pnpm-lock.yaml"));
    for (const n of nowLock) {
      if (!baseLock.has(n)) added.set(n, [...(added.get(n) ?? []), "pnpm-lock.yaml importers"]);
    }
    if (baseNames.size < 20 || baseLock.size < 20 || nowLock.size < 20) {
      hits.push(
        `too few dependency names parsed (base ${baseNames.size}, lockfile base ${baseLock.size} / now ${nowLock.size}): parser out of date?`,
      );
    }
    for (const [n, where] of added) {
      if (!ALLOWED_NEW.has(n)) hits.push(`new dependency ${n} (${[...new Set(where)].join(", ")})`);
    }
    const allowedSeen = [...added.keys()].filter((n) => ALLOWED_NEW.has(n));
    report(
      `no new dependency since ${base} except ${[...ALLOWED_NEW].join(", ")} (new: ${allowedSeen.join(", ") || "none"}; ${baseFiles.length} manifests at base, ${nowFiles.length} now, ${nowLock.size} lockfile importer names)`,
      hits,
    );
  }
}

const API_IMPORTS = "apps/api/src/imports";
const WORKER_IMPORT = "apps/worker/src/import";
const WORKER_SRC = "apps/worker/src";
const PHOTO_SYNC_TS = "apps/mobile-web/src/platform/native/photoSync.ts";
const PHOTO_SYNC_SWIFT = "apps/mobile-web/ios/App/App/TinyglowPhotoSync.swift";
const DOWNLOAD_TS = "apps/worker/src/import/google/download.ts";
const HANDLER_TS = "apps/worker/src/import/google/handler.ts";
const FAKE_SERVER_TS = "apps/worker/src/import/google/fake-server.ts";
const SHARED_ENV = "packages/shared/src/env.ts";
const API_CONFIG = "apps/api/src/config.ts";
const WORKER_CONFIG = "apps/worker/src/config.ts";
const MIGRATIONS = "packages/db/migrations";
const BOOTSTRAP = "packages/db/src/bootstrap.ts";
const PROD_COMPOSE = "docker-compose.yml";
const MOBILE_WEB = "apps/mobile-web";
const SHARED_API = "packages/shared/src/api";
const DOCKER_DIR = "docker";

const missing = [
  API_IMPORTS,
  WORKER_IMPORT,
  WORKER_SRC,
  PHOTO_SYNC_TS,
  PHOTO_SYNC_SWIFT,
  DOWNLOAD_TS,
  HANDLER_TS,
  FAKE_SERVER_TS,
  SHARED_ENV,
  API_CONFIG,
  WORKER_CONFIG,
  MIGRATIONS,
  BOOTSTRAP,
  PROD_COMPOSE,
  MOBILE_WEB,
  SHARED_API,
  DOCKER_DIR,
].filter((p) => !exists(p));
if (missing.length > 0) {
  for (const p of missing) console.error(`::error::${p} is missing`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Files
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "www",
  "DerivedData",
  "Pods",
  ".gradle",
  "public",
]);
function walk(rel, out = []) {
  const st = statSync(abs(rel));
  if (!st.isDirectory()) {
    out.push(rel);
    return out;
  }
  for (const name of readdirSync(abs(rel)).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walk(`${rel}/${name}`, out);
  }
  return out;
}
const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|testing)\//;
const isSource = (f) => TS_SOURCE.test(f) && !TEST.test(f) && !f.endsWith(".d.ts");

const apiImportFiles = walk(API_IMPORTS).filter(isSource);
const workerImportFiles = walk(WORKER_IMPORT).filter(isSource);
const scopeFiles = [...apiImportFiles, ...workerImportFiles, PHOTO_SYNC_TS];
for (const [dir, files] of [
  [API_IMPORTS, apiImportFiles],
  [WORKER_IMPORT, workerImportFiles],
]) {
  if (files.length === 0) {
    console.error(`::error::${dir} has no source files`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------------------------
// Lexer (same as sentry-hygiene.mjs): { code, skel } of the same length as src. `code` has
// comments blanked; `skel` additionally blanks the contents of strings, template literals (the
// `${…}` interpolations stay) and regex literals, so bracket matching and identifier regexes on
// `skel` cannot be fooled by text.
function lex(src) {
  const code = src.split("");
  const skel = src.split("");
  const n = src.length;
  const blank = (arr, a, b) => {
    for (let k = a; k < b; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  const REGEX_PREV = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
  const REGEX_KW =
    /(?:^|[^\w$])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;
  let i = 0;
  let lastSig = "";
  let lastSigPos = -1;
  const tmplStack = [];
  let depth = 0;
  const readTemplate = (start) => {
    let k = start;
    while (k < n) {
      if (src[k] === "\\") {
        k += 2;
        continue;
      }
      if (src[k] === "`") {
        blank(skel, start, k);
        return k + 1;
      }
      if (src[k] === "$" && src[k + 1] === "{") {
        blank(skel, start, k);
        tmplStack.push(depth);
        depth++;
        return k + 2;
      }
      k++;
    }
    blank(skel, start, n);
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? n : e;
      blank(code, i, end);
      blank(skel, i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(code, i, end);
      blank(skel, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      blank(skel, i + 1, k);
      i = k + 1;
      lastSig = c;
      lastSigPos = k;
      continue;
    }
    if (c === "`") {
      i = readTemplate(i + 1);
      lastSig = "`";
      lastSigPos = i - 1;
      continue;
    }
    if (c === "/") {
      const before = src.slice(Math.max(0, lastSigPos - 10), lastSigPos + 1);
      if (lastSigPos < 0 || REGEX_PREV.has(lastSig) || REGEX_KW.test(before)) {
        let k = i + 1;
        let inClass = false;
        while (k < n && src[k] !== "\n") {
          if (src[k] === "\\") {
            k += 2;
            continue;
          }
          if (src[k] === "[") inClass = true;
          else if (src[k] === "]") inClass = false;
          else if (src[k] === "/" && !inClass) break;
          k++;
        }
        blank(skel, i + 1, k);
        k++;
        while (k < n && /[a-z]/i.test(src[k])) k++;
        i = k;
        lastSig = "/";
        lastSigPos = k - 1;
        continue;
      }
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (c === "}" && tmplStack.length && tmplStack[tmplStack.length - 1] === depth) {
        tmplStack.pop();
        i = readTemplate(i + 1);
        lastSig = "`";
        lastSigPos = i - 1;
        continue;
      }
    }
    if (!/\s/.test(c)) {
      lastSig = c;
      lastSigPos = i;
    }
    i++;
  }
  return { code: code.join(""), skel: skel.join("") };
}

const OPEN = { "{": "}", "(": ")", "[": "]" };
function matchClose(skel, open) {
  const stack = [];
  for (let k = open; k < skel.length; k++) {
    const ch = skel[k];
    if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return k;
    }
  }
  return -1;
}
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
/** Top-level comma split of skel[a, b) (brackets respected). Returns [start, end) pairs. */
function splitArgs(skel, a, b) {
  const parts = [];
  let depth = 0;
  let start = a;
  for (let k = a; k < b; k++) {
    const ch = skel[k];
    if (OPEN[ch]) depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  if (skel.slice(start, b).trim()) parts.push([start, b]);
  return parts;
}

const lexed = new Map();
function lexFile(rel) {
  if (!lexed.has(rel)) {
    const src = read(rel);
    lexed.set(rel, { src, ...lex(src) });
  }
  return lexed.get(rel);
}

// ---------------------------------------------------------------------------------------------
// 1. Logging
{
  const consoleHits = [];
  for (const f of scopeFiles) {
    const { src, skel } = lexFile(f);
    for (const m of skel.matchAll(/(?<![\w$.])console\s*\.\s*\w+\s*\(/g)) {
      consoleHits.push(`${f}:${lineOf(src, m.index)}: console call`);
    }
  }
  report("no console.* call in the import code", consoleHits);

  // Any receiver path ending in log / logger / *Log / *Logger, then a pino method.
  const LOG_CALL =
    /(?<![\w$])(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*(?:log|logger|[A-Za-z_$][\w$]*(?:Log|Logger))\s*(?:\?\.|\.)\s*(trace|debug|info|warn|error|fatal|child)\s*\(/g;
  const ALWAYS =
    /(?<![\w$])(baseUrls?|pickerUri|mediaDownloadUrl|googleMediaDownloadUrl|refresh_token|access_token|refreshToken|accessToken|id_token|idToken|authorization|Authorization|client_secret|clientSecret|GOOGLE_IMPORT_CLIENT_SECRET)(?![\w$])/g;
  const VALUE =
    /(?<![\w$.])(tokens?|code|state|grant|creds|url|href|uri|location|headers)(?![\w$])/g;
  const RAW_ERROR_SHORTHAND = /(?:^|[{,])\s*(?:err|error|e|cause)\s*(?=[,}])/;
  const RAW_ERROR_VALUE = /(?<![\w$])\w+\s*:\s*(?:err|error|e|cause)\s*(?=[,}])/;
  const logHits = [];
  const perDir = { [API_IMPORTS]: 0, [WORKER_IMPORT]: 0 };
  let calls = 0;
  for (const f of scopeFiles) {
    const { src, skel } = lexFile(f);
    for (const m of skel.matchAll(LOG_CALL)) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(skel, open);
      const where = `${f}:${lineOf(src, m.index)}`;
      if (close < 0) {
        logHits.push(`${where}: cannot parse logger call`);
        continue;
      }
      calls++;
      for (const d of Object.keys(perDir)) if (f.startsWith(`${d}/`)) perDir[d]++;
      const argsText = skel.slice(open + 1, close);
      for (const a of argsText.matchAll(ALWAYS)) logHits.push(`${where}: logs ${a[1]}`);
      for (const a of argsText.matchAll(VALUE)) {
        const after = argsText.slice(a.index + a[0].length);
        // Object key (`code: …`, but not the `? x : y` of a ternary), comparison, .length.
        if (/^\s*:/.test(after) && !/\?\s*$/.test(argsText.slice(0, a.index))) continue;
        if (/^\s*(?:[=!]==?|\.length\b|\?\.length\b)/.test(after)) continue;
        if (/typeof\s+$/.test(argsText.slice(0, a.index))) continue;
        logHits.push(`${where}: logs the value of ${a[1]}`);
      }
      const parts = splitArgs(skel, open + 1, close).map(([a, b]) => skel.slice(a, b).trim());
      const first = parts[0] ?? "";
      if (
        /^(?:err|error|e|cause)$/.test(first) ||
        RAW_ERROR_SHORTHAND.test(first) ||
        RAW_ERROR_VALUE.test(first)
      ) {
        logHits.push(`${where}: logs a raw error object (log a category instead)`);
      }
    }
  }
  for (const [d, n] of Object.entries(perDir)) {
    if (n === 0) logHits.push(`${d}: no logger call found (the scan would be vacuous)`);
  }
  report(
    `logger calls in the import code (${calls}) carry no URL, picker URI, token, code, secret or raw error`,
    logHits,
  );

  const swift = read(PHOTO_SYNC_SWIFT);
  const swiftCode = swift
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  const swiftHits = [];
  if (!/\bPHPhotoLibrary\b/.test(swiftCode)) {
    swiftHits.push(`${PHOTO_SYNC_SWIFT}: no PHPhotoLibrary use (wrong file?)`);
  }
  for (const m of swiftCode.matchAll(
    /(?<![\w.])(print|debugPrint|dump|NSLog|os_log)\s*\(|(?<![\w.])Logger\s*\(|\bos\.Logger\b/g,
  )) {
    swiftHits.push(`${PHOTO_SYNC_SWIFT}:${lineOf(swiftCode, m.index)}: ${m[0].trim()}`);
  }
  report(`${PHOTO_SYNC_SWIFT} has no print/NSLog/os_log/Logger`, swiftHits);
}

// ---------------------------------------------------------------------------------------------
// SQL helpers for the migration checks: comments stripped, split into statements.
function sqlStatements(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
  return noComments
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
const migrationFiles = walk(MIGRATIONS).filter((f) => f.endsWith(".sql"));
if (migrationFiles.length === 0) {
  console.error(`::error::${MIGRATIONS} has no .sql files`);
  process.exit(1);
}
const WORKER_ROLES = /\bTO\b[^;]*\b(pipeline|tinyglow_worker|PUBLIC)\b/i;
function grantsTo(table, privilege) {
  const hits = [];
  const onTable = new RegExp(
    `\\bON\\s+(?:TABLE\\s+)?(?:[\\w."]+\\s*,\\s*)*(?:public\\s*\\.\\s*)?"?${table}"?(?![\\w"])`,
    "i",
  );
  for (const f of migrationFiles) {
    for (const st of sqlStatements(read(f))) {
      if (!/^GRANT\b/i.test(st) || !onTable.test(st) || !WORKER_ROLES.test(st)) continue;
      if (/\bON\s+(FUNCTION|SEQUENCE|SCHEMA)\b/i.test(st)) continue;
      if (privilege && !privilege.test(st.replace(/\bON\b.*$/i, ""))) continue;
      hits.push(`${f}: ${st.slice(0, 160)}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// 2. The worker never reads google_accounts (nor holds service_role).
{
  const workerFiles = walk(WORKER_SRC).filter(isSource);
  const hits = [];
  for (const f of workerFiles) {
    const { src, code } = lexFile(f);
    for (const m of code.matchAll(
      /\b(google_accounts|refresh_token_enc|decrypt_secret|service_role|withServiceRole)\b/g,
    )) {
      hits.push(`${f}:${lineOf(src, m.index)}: ${m[1]}`);
    }
  }
  const usesFn = workerImportFiles.some((f) =>
    /\bimport_google_refresh_token\s*\(/.test(lexFile(f).code),
  );
  if (!usesFn) {
    hits.push(`${WORKER_IMPORT}: import_google_refresh_token( is not used (token path moved?)`);
  }
  report(
    "the worker never names google_accounts / refresh_token_enc / decrypt_secret / service_role; its token comes from import_google_refresh_token()",
    hits,
  );

  report(
    "no migration grants anything on google_accounts to pipeline / tinyglow_worker / PUBLIC",
    grantsTo("google_accounts", null),
  );

  const boot = read(BOOTSTRAP);
  const bootHits = [];
  // Role memberships only: `format('GRANT <roles> TO %I …', '${APP_ROLES.worker}')` (no ON clause).
  const workerGrants = [
    ...boot.matchAll(
      /format\(\s*'GRANT ((?:(?!\bON\b)[^'])*?) TO %I[^']*',\s*'\$\{APP_ROLES\.worker\}'/g,
    ),
  ];
  if (workerGrants.length === 0) {
    bootHits.push(`${BOOTSTRAP}: no role grant to APP_ROLES.worker found (moved?)`);
  }
  for (const g of workerGrants) {
    const roles = g[1].split(",").map((s) => s.trim());
    if (roles.some((r) => r !== "pipeline")) {
      bootHits.push(
        `${BOOTSTRAP}:${lineOf(boot, g.index)}: worker login role gets ${roles.join(", ")}`,
      );
    }
  }
  report("the worker login role is granted pipeline only (never service_role)", bootHits);
}

// ---------------------------------------------------------------------------------------------
// 3. The worker never inserts into photos.
{
  const hits = [];
  for (const f of workerImportFiles) {
    const { src, code } = lexFile(f);
    for (const m of code.matchAll(
      /\binsert\s+into\s+(?:"?public"?\s*\.\s*)?"?photos"?(?![\w"])|\binsertInto\s*\(\s*["'`](?:public\.)?photos["'`]|\bcopy\s+(?:"?public"?\s*\.\s*)?"?photos"?(?![\w"])/gi,
    )) {
      hits.push(`${f}:${lineOf(src, m.index)}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  if (!workerImportFiles.some((f) => /\bimport_book_photo\s*\(/.test(lexFile(f).code))) {
    hits.push(`${WORKER_IMPORT}: import_book_photo( is not used (booking path moved?)`);
  }
  report(
    `${WORKER_IMPORT} never inserts into photos (booking only through import_book_photo())`,
    hits,
  );
  report(
    "no migration grants INSERT (or ALL) on photos to pipeline / tinyglow_worker / PUBLIC",
    grantsTo("photos", /\b(INSERT|ALL)\b/i),
  );
}

// ---------------------------------------------------------------------------------------------
// 4. SSRF guard before every media fetch.
{
  const serverFiles = [...apiImportFiles, ...workerImportFiles];
  const hits = [];

  // a. The URL builders (mediaDownloadUrl, step 12's googleMediaDownloadUrl) only as the direct
  // argument of the guard.
  let guarded = 0;
  for (const f of serverFiles) {
    const { src, skel } = lexFile(f);
    for (const m of skel.matchAll(/(?<![\w$])(mediaDownloadUrl|googleMediaDownloadUrl)\s*\(/g)) {
      const before = skel.slice(Math.max(0, m.index - 80), m.index);
      if (/(?:parseAllowedMediaUrl|isAllowedMediaUrl)\s*\(\s*$/.test(before)) guarded++;
      else hits.push(`${f}:${lineOf(src, m.index)}: ${m[1]}( outside the URL guard`);
    }
  }
  if (guarded === 0)
    hits.push(
      "no guarded mediaDownloadUrl( / googleMediaDownloadUrl( call found (the check would be vacuous)",
    );

  // b. No request call takes a media URL directly.
  const REQUEST_CALL =
    /(?<![\w$])(fetch|fetchImpl|once|withRetry|request|got|undici\.request|https?\.(?:get|request))\s*\(/g;
  const MEDIA_NAMES =
    /(?<![\w$])(baseUrls?|mediaFile|mediaDownloadUrl|googleMediaDownloadUrl)(?![\w$])/;
  const requestSites = [];
  for (const f of serverFiles) {
    const { src, skel } = lexFile(f);
    for (const m of skel.matchAll(REQUEST_CALL)) {
      // Skip declarations (`function once(`, `async function withRetry(`) and method shorthands.
      if (/(?:function\s+|async\s+)$/.test(skel.slice(Math.max(0, m.index - 16), m.index)))
        continue;
      const open = m.index + m[0].length - 1;
      const close = matchClose(skel, open);
      if (close < 0) continue;
      if (/^\s*\{/.test(skel.slice(close + 1)) || /^\s*:\s*[\w<]/.test(skel.slice(close + 1))) {
        continue; // a declaration's parameter list
      }
      const argsText = skel.slice(open + 1, close);
      requestSites.push({ f, src, skel, m, open, close });
      if (MEDIA_NAMES.test(argsText)) {
        hits.push(
          `${f}:${lineOf(src, m.index)}: ${m[1]}( is passed a media URL (use downloadMedia)`,
        );
      }
    }
  }

  // c. download.ts: every request URL comes from a null-checked guard result.
  const dl = lexFile(DOWNLOAD_TS);
  const guardVars = new Set();
  for (const m of dl.skel.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(parseAllowedMediaUrl|resolveMediaRedirect)\s*\(/g,
  )) {
    const name = m[1];
    const close = matchClose(dl.skel, m.index + m[0].length - 1);
    const rest = dl.skel.slice(close + 1, close + 1 + 160);
    const checked = new RegExp(
      `^\\s*;?\\s*if\\s*\\(\\s*!\\s*${name}\\s*\\)\\s*(?:\\{\\s*)?throw\\b`,
    ).test(rest);
    if (!checked) {
      hits.push(
        `${DOWNLOAD_TS}:${lineOf(dl.src, m.index)}: ${name} (from ${m[2]}) is not null-checked with a throw right after`,
      );
    } else guardVars.add(name);
  }
  if (!guardVars.size) hits.push(`${DOWNLOAD_TS}: no guarded URL variable found (guard moved?)`);
  const dlSites = requestSites.filter((s) => s.f === DOWNLOAD_TS);
  let guardedFetches = 0;
  for (const s of dlSites) {
    const where = `${DOWNLOAD_TS}:${lineOf(dl.src, s.m.index)}`;
    const parts = splitArgs(s.skel, s.open + 1, s.close).map(([a, b]) => s.skel.slice(a, b).trim());
    const urlArg = parts[0] ?? "";
    // The default `(input, init) => fetch(input, init)` passthrough is not a call site.
    const lead = s.skel.slice(Math.max(0, s.m.index - 60), s.m.index);
    const passthrough = new RegExp(
      `\\(\\s*${urlArg.replace(/[$]/g, "\\$")}\\s*,\\s*[\\w$]+\\s*\\)\\s*=>\\s*$`,
    );
    if (/^[A-Za-z_$][\w$]*$/.test(urlArg) && passthrough.test(lead)) continue;
    const v = /^([A-Za-z_$][\w$]*)(?:\.href)?$/.exec(urlArg)?.[1];
    if (!v) {
      hits.push(
        `${where}: request URL argument is not a guarded variable (${urlArg.slice(0, 40)})`,
      );
      continue;
    }
    const assigns = [
      ...s.skel.matchAll(
        new RegExp(`(?<![\\w$.])${v}\\s*(?::\\s*[\\w$<>|. ]+)?\\s*=(?![=>])\\s*([^;\\n]+)`, "g"),
      ),
    ];
    if (assigns.length === 0) hits.push(`${where}: ${v} is never assigned in ${DOWNLOAD_TS}`);
    for (const a of assigns) {
      const rhs = a[1].trim().replace(/\s+as\s+[\w$<>|. ]+$/, "");
      const rhsName = rhs
        .replace(/^\(\s*/, "")
        .replace(/\s*\)$/, "")
        .replace(/\s+as\s+[\w$<>|. ]+$/, "");
      if (!guardVars.has(rhsName)) {
        hits.push(
          `${DOWNLOAD_TS}:${lineOf(dl.src, a.index)}: ${v} = ${rhs.slice(0, 40)} (not a guarded value)`,
        );
      }
    }
    if (!/\bredirect\s*:\s*"manual"/.test(dl.code.slice(s.open, s.close))) {
      hits.push(`${where}: request without redirect: "manual"`);
    }
    guardedFetches++;
  }
  if (guardedFetches === 0) hits.push(`${DOWNLOAD_TS}: no media request call found (moved?)`);

  // d. The handler downloads through downloadMedia; nothing follows redirects automatically.
  if (!/(?<![\w$])downloadMedia\s*\(/.test(lexFile(HANDLER_TS).skel)) {
    hits.push(`${HANDLER_TS}: downloadMedia( is not called (download path moved?)`);
  }
  for (const f of serverFiles) {
    const { src, code } = lexFile(f);
    for (const m of code.matchAll(/\bredirect\s*:\s*["'`]follow["'`]/g)) {
      hits.push(`${f}:${lineOf(src, m.index)}: redirect: "follow"`);
    }
  }
  report(
    `the URL guard (parseAllowedMediaUrl / resolveMediaRedirect, null-checked) precedes every media request (${guardedFetches} in ${DOWNLOAD_TS}, ${guarded} guarded media URL builder call(s))`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// 5. The fake is refused in production (static half; import-hygiene.sh proves it at runtime).
{
  const hits = [];
  const env = lexFile(SHARED_ENV).code;
  if (
    !/GOOGLE_IMPORT_PROVIDER\s*===\s*"fake"\s*&&\s*env\.NODE_ENV\s*===\s*"production"|env\.NODE_ENV\s*===\s*"production"\s*&&\s*env\.GOOGLE_IMPORT_PROVIDER\s*===\s*"fake"/.test(
      env,
    )
  ) {
    hits.push(`${SHARED_ENV}: no fake-in-production refinement on GOOGLE_IMPORT_PROVIDER`);
  }
  for (const f of [API_CONFIG, WORKER_CONFIG]) {
    // A value use: not the import statement, not a `typeof` in a type.
    const body = lexFile(f).code.replace(/\bimport\s[^;]*?\bfrom\s*["'][^"']+["']\s*;?/g, " ");
    if (!/(?<!typeof\s+)\bgoogleImportEnvSchema\b/.test(body)) {
      hits.push(`${f}: does not compose googleImportEnvSchema`);
    }
  }
  const fake = lexFile(FAKE_SERVER_TS).code;
  const refusals = fake.match(/===\s*"production"/g)?.length ?? 0;
  if (refusals < 2) {
    hits.push(
      `${FAKE_SERVER_TS}: expected a production refusal in both the library and the CLI (found ${refusals})`,
    );
  }
  const prod = read(PROD_COMPOSE)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  if (/^\s{2}google-fake\s*:/m.test(prod) || /google-fake/.test(prod)) {
    hits.push(`${PROD_COMPOSE}: mentions google-fake outside comments`);
  }
  if (
    /GOOGLE_IMPORT_PROVIDER\s*:\s*\$\{GOOGLE_IMPORT_PROVIDER:-fake\}|GOOGLE_IMPORT_PROVIDER\s*:\s*"?fake"?\s*$/m.test(
      prod,
    )
  ) {
    hits.push(`${PROD_COMPOSE}: GOOGLE_IMPORT_PROVIDER defaults to fake`);
  }
  report(
    "the fake Google provider is refused in production (schema, configs, fake server, prod Compose)",
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// 6. The OAuth client secret never reaches the client app or the web image.
{
  const hits = [];
  const files = [
    ...walk(MOBILE_WEB).filter(
      (f) => !/\.(png|jpe?g|gif|webp|heic|ico|jar|keystore|zip|ttf|woff2?)$/i.test(f),
    ),
    ...walk(SHARED_API),
    ...walk(DOCKER_DIR),
  ];
  for (const f of files) {
    let text;
    try {
      text = read(f);
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    for (const m of text.matchAll(/GOOGLE_IMPORT_CLIENT_SECRET|VITE_GOOGLE_IMPORT_\w*/g)) {
      hits.push(`${f}:${lineOf(text, m.index)}: ${m[0]}`);
    }
  }
  report(
    `GOOGLE_IMPORT_CLIENT_SECRET / VITE_GOOGLE_IMPORT_* never in ${MOBILE_WEB}, ${SHARED_API} or ${DOCKER_DIR}/`,
    hits,
  );
}

process.exit(failed ? 1 : 0);
