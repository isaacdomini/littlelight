#!/usr/bin/env node
// Live-update hygiene, static part (docs/plans/step-14.md 2.9 "CI", 5.3; task 14.11). Run by
// .github/scripts/app-update-hygiene.sh and runnable on its own from the repo root:
//
//   node .github/scripts/app-update-hygiene.mjs [--root <dir>]
//
//  a. One set of trusted keys. The `prod` and `dev` entries of APP_UPDATE_PUBLIC_KEYS in
//     packages/shared/src/app-update.ts (keyId + spkiBase64) equal LLUpdateKeys.swift
//     (prodKeyId/prodSpkiBase64, devKeyId/devSpkiBase64) and UpdateKeys.java (PROD_KEY_ID /
//     PROD_SPKI_BASE64 and the "dev" entry); each SPKI decodes to an EC P-256 public key, no
//     placeholder is left and prod != dev.
//  b. The dev key ships in Debug builds only. In the app's Swift sources (ios/App/App/**) the dev
//     SPKI literal and every devSpkiBase64 / devKeyId reference sit inside `#if DEBUG` (not its
//     `#else`); in the Android main sources (android/app/src/main/**) every occurrence of the dev
//     SPKI literal sits inside the braces of an `if (BuildConfig.DEBUG) {` block.
//  c. No private-key material in the repo except `.env.dev`'s APP_UPDATE_SIGNING_KEY_BASE64 line:
//     no base64/base64url PKCS#8 EC key (`MIG?AgEAMBMGByqGSM49AgEG` + body), SEC1 EC key
//     (`MHcCAQEEI` + body) or hex PKCS#8 P-256 DER in any file git tracks or would add
//     (`git ls-files -co --exclude-standard`; a `--root` without .git is walked instead, skipping
//     node_modules/build output and the git-ignored .env / .env.local / .env.*.local).
//  d. Env files: APP_UPDATE_SIGNING_KEY_BASE64 is present and empty in .env.example; set in
//     .env.dev, where it parses as PKCS#8 DER of an EC P-256 key whose public half is the shared
//     `dev` SPKI (the committed dev key can never be the production key).
//  e. The api never logs the signature, the manifest or the key. No logger call in apps/api/src
//     (non-test .ts) names an identifier containing signature, manifestJson, signingKey,
//     privateKey, pkcs8, keyBase64, spki or envelope; in apps/api/src/app-update/** every logger
//     call's object has only the keys outcome/status/stale/platform/keyId (+ err: safeErrorLog(…)),
//     every message is a string literal, and there is no console.* call; telemetry
//     (packages/shared/src/telemetry.ts) scrubs signature, manifestjson,
//     appupdatesigningkeybase64 and the PKCS#8 key shape.
//  f. The updater sources do not log: no print/debugPrint/NSLog/os_log/dump/Logger/CAPLog in
//     TinyglowUpdater.swift, LLUpdateBundle.swift, LLUpdateKeys.swift; no Log.*/System.out/err/
//     printStackTrace/Logger in android/.../update/*.java (main); no console.* in
//     platform/native/appUpdate.ts and appUpdateStatus.ts. Comments are ignored.
//  g. No third-party updater: no @capgo/*, @ionic-enterprise/*, *capacitor-updater* or *appflow*
//     dependency in any package.json (outside node_modules).
//  h. apps/mobile-web/package.json `build`, `native:build` and `native:build:release` all end with
//     `&& node scripts/app-update-manifest.mjs dist` (the builtin bundle has an identity).
//  i. apps/mobile-web/app-update.json parses (webVersion, minNativeBuild.ios/android integers >= 1)
//     and minNativeBuild is <= the shells' current build numbers (every CURRENT_PROJECT_VERSION in
//     the iOS pbxproj, versionCode in android/app/build.gradle): a web that needs a native build
//     nobody has would be refused by every phone.
//  j. Build-flag drift (5.3): every VITE_* name in apps/mobile-web/src (non-test) is in the
//     allow-list below. The OTA bundle is the web image's build, so a new build-time flag that
//     differs between the web image and the native shells must be handled before it is listed.
//
// Every path the checks read must exist, so a move or rename fails instead of passing silently.
// `--root` points the checks at a copy of the tree (negative tests: copy, plant a violation, see
// it fail). Prints locations and rule names only, never file contents or key material. Only
// Node built-ins.
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) root = path.resolve(args[++i]);
  else {
    console.error("usage: app-update-hygiene.mjs [--root <dir>]");
    process.exit(2);
  }
}

let failed = false;
function report(what, hits) {
  if (hits.length === 0) {
    console.log(`ok: ${what}`);
    return;
  }
  for (const h of hits.slice(0, 40)) console.error(`  ${h}`);
  if (hits.length > 40) console.error(`  … ${hits.length - 40} more`);
  console.error(`::error::${what} (${hits.length} violation(s) above)`);
  failed = true;
}

const abs = (rel) => path.join(root, rel);
const isFile = (rel) => {
  try {
    return statSync(abs(rel)).isFile();
  } catch {
    return false;
  }
};
const isDir = (rel) => {
  try {
    return statSync(abs(rel)).isDirectory();
  } catch {
    return false;
  }
};
const read = (rel) => readFileSync(abs(rel), "utf8");
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

const SHARED = "packages/shared/src/app-update.ts";
const TELEMETRY = "packages/shared/src/telemetry.ts";
const IOS_APP = "apps/mobile-web/ios/App/App";
const SWIFT_KEYS = `${IOS_APP}/LLUpdateKeys.swift`;
const SWIFT_UPDATER = [
  `${IOS_APP}/TinyglowUpdater.swift`,
  `${IOS_APP}/LLUpdateBundle.swift`,
  SWIFT_KEYS,
];
const ANDROID_MAIN = "apps/mobile-web/android/app/src/main";
const JAVA_UPDATE = `${ANDROID_MAIN}/java/app/tinyglow/update`;
const JAVA_KEYS = `${JAVA_UPDATE}/UpdateKeys.java`;
const WEB_SRC = "apps/mobile-web/src";
const JS_UPDATER = [
  `${WEB_SRC}/platform/native/appUpdate.ts`,
  `${WEB_SRC}/platform/native/appUpdateStatus.ts`,
];
const API_SRC = "apps/api/src";
const API_APP_UPDATE = `${API_SRC}/app-update`;
const ENV_DEV = ".env.dev";
const ENV_EXAMPLE = ".env.example";
const WEB_PKG = "apps/mobile-web/package.json";
const APP_UPDATE_JSON = "apps/mobile-web/app-update.json";
const PBXPROJ = "apps/mobile-web/ios/App/App.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile-web/android/app/build.gradle";

const missing = [
  ...[IOS_APP, JAVA_UPDATE, WEB_SRC, API_SRC, API_APP_UPDATE].filter((d) => !isDir(d)),
  ...[
    SHARED,
    TELEMETRY,
    ...SWIFT_UPDATER,
    JAVA_KEYS,
    ...JS_UPDATER,
    ENV_DEV,
    ENV_EXAMPLE,
    WEB_PKG,
    APP_UPDATE_JSON,
    PBXPROJ,
    GRADLE,
  ].filter((f) => !isFile(f)),
];
if (missing.length) {
  for (const m of missing) console.error(`::error::${m} is missing`);
  process.exit(1);
}

/** Recursive file list under `rel` (relative paths), skipping build output and dependencies. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "DerivedData",
  ".gradle",
  "Pods",
  ".turbo",
  "coverage",
  "test-results",
  "playwright-report",
]);
function walk(rel, out = []) {
  const dir = rel === "" ? root : abs(rel);
  for (const name of readdirSync(dir).sort()) {
    const child = rel === "" ? name : `${rel}/${name}`;
    let st;
    try {
      st = statSync(abs(child));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(child, out);
    } else if (st.isFile()) out.push(child);
  }
  return out;
}

/** The repo's file set: git's tracked + addable files, or a walk when `root` is not a work tree. */
function repoFiles() {
  if (isDir(".git") || isFile(".git")) {
    const outp = execFileSync("git", ["-C", root, "ls-files", "-z", "-co", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return outp.split("\0").filter((f) => f && isFile(f));
  }
  return walk("").filter((f) => !/(^|\/)\.env(\.local|\.[^/]*\.local)?$/.test(f));
}

/**
 * Blank comments of a C-family source (Swift, Java, TS) keeping strings and newlines, so text
 * checks see code only. Swift `"""` blocks are treated as strings.
 */
function stripComments(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' && src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      i = e === -1 ? n : e + 3;
    } else if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < n && src[k] !== c && (c === "`" || src[k] !== "\n")) k += src[k] === "\\" ? 2 : 1;
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// a. One set of trusted keys
const keys = { shared: {}, swift: {}, java: {} };
{
  const hits = [];
  const shared = stripComments(read(SHARED));
  const block = /APP_UPDATE_PUBLIC_KEYS\b[\s\S]*?=\s*[\s\S]*?\{([\s\S]*?)\n\s*\}\s*\)\s*;/.exec(
    shared,
  );
  if (!block) hits.push(`${SHARED}: APP_UPDATE_PUBLIC_KEYS not found`);
  else {
    for (const name of ["prod", "dev"]) {
      const m = new RegExp(
        `\\b${name}\\s*:\\s*(?:Object\\.freeze\\()?\\{[^}]*?keyId\\s*:\\s*"([^"]*)"[^}]*?spkiBase64\\s*:\\s*"([^"]*)"`,
      ).exec(block[1]);
      if (!m)
        hits.push(`${SHARED}: APP_UPDATE_PUBLIC_KEYS.${name} { keyId, spkiBase64 } not found`);
      else keys.shared[name] = { keyId: m[1], spki: m[2] };
    }
  }
  const swift = stripComments(read(SWIFT_KEYS));
  const sv = (id) => new RegExp(`static\\s+let\\s+${id}\\s*=\\s*"([^"]*)"`).exec(swift)?.[1];
  keys.swift.prod = { keyId: sv("prodKeyId"), spki: sv("prodSpkiBase64") };
  keys.swift.dev = { keyId: sv("devKeyId"), spki: sv("devSpkiBase64") };
  const java = stripComments(read(JAVA_KEYS));
  const jv = (id) => new RegExp(`\\b${id}\\s*=\\s*"([^"]*)"`).exec(java)?.[1];
  keys.java.prod = { keyId: jv("PROD_KEY_ID"), spki: jv("PROD_SPKI_BASE64") };
  // The dev entry is the put() whose keyId is the shared dev keyId (extra rotation entries,
  // docs/PRODUCTION.md L7, are other puts and are not compared).
  const jd = /\.put\(\s*(?:"([^"]*)"|DEV_KEY_ID)\s*,\s*(?:"([^"]*)"|DEV_SPKI_BASE64)\s*\)/g;
  for (const m of java.matchAll(jd)) {
    const id = m[1] ?? jv("DEV_KEY_ID");
    const spki = m[2] ?? jv("DEV_SPKI_BASE64");
    if (id && id === keys.shared.dev?.keyId) keys.java.dev = { keyId: id, spki };
  }
  keys.java.dev ??= {};

  const p256 = (b64) => {
    try {
      const k = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
      return k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1";
    } catch {
      return false;
    }
  };
  for (const name of ["prod", "dev"]) {
    const s = keys.shared[name];
    if (!s) continue;
    if (!s.spki || /<|set by/i.test(s.spki)) hits.push(`${SHARED}: ${name} SPKI is a placeholder`);
    else if (!p256(s.spki))
      hits.push(`${SHARED}: ${name} SPKI is not an EC P-256 SubjectPublicKeyInfo`);
    for (const [where, rel] of [
      ["swift", SWIFT_KEYS],
      ["java", JAVA_KEYS],
    ]) {
      const o = keys[where][name];
      if (!o?.spki) hits.push(`${rel}: ${name} SPKI not found`);
      else if (o.spki !== s.spki) hits.push(`${rel}: ${name} SPKI differs from ${SHARED}`);
      if (!o?.keyId) hits.push(`${rel}: ${name} keyId not found`);
      else if (o.keyId !== s.keyId) hits.push(`${rel}: ${name} keyId differs from ${SHARED}`);
    }
  }
  if (keys.shared.prod && keys.shared.dev && keys.shared.prod.spki === keys.shared.dev.spki) {
    hits.push(`${SHARED}: prod and dev SPKI are the same key`);
  }
  report(
    "APP_UPDATE_PUBLIC_KEYS (prod, dev) are EC P-256 and identical in shared, LLUpdateKeys.swift and UpdateKeys.java",
    hits,
  );
}
const DEV_SPKI = keys.shared.dev?.spki;

// ---------------------------------------------------------------------------------------------
// b. The dev key only in Debug builds
{
  const hits = [];
  if (!DEV_SPKI) hits.push(`${SHARED}: no dev SPKI to look for (see a.)`);
  else {
    // Swift: #if DEBUG regions by line.
    const swiftFiles = walk(IOS_APP).filter((f) => f.endsWith(".swift"));
    for (const rel of swiftFiles) {
      const lines = stripComments(read(rel)).split("\n");
      const stack = [];
      lines.forEach((line, i) => {
        const t = line.trim();
        const m = /^#if\s+(.*)$/.exec(t);
        if (m) stack.push(m[1].trim() === "DEBUG" ? "debug" : "other");
        else if (/^#elseif\b/.test(t)) stack[stack.length - 1] = "other";
        else if (/^#else\b/.test(t))
          stack[stack.length - 1] = stack[stack.length - 1] === "debug" ? "notdebug" : "other";
        else if (/^#endif\b/.test(t)) stack.pop();
        else {
          const inDebug = stack.includes("debug") && !stack.includes("notdebug");
          if (!inDebug && (line.includes(DEV_SPKI) || /\b(devSpkiBase64|devKeyId)\b/.test(line))) {
            hits.push(`${rel}:${i + 1}: dev key outside #if DEBUG`);
          }
        }
      });
    }
    // Android main sources: the literal only inside `if (BuildConfig.DEBUG) { … }`.
    const mainFiles = walk(ANDROID_MAIN).filter(
      (f) =>
        /\.(java|kt|xml|json|properties)$/.test(f) &&
        !f.startsWith(`${ANDROID_MAIN}/assets/public/`),
    );
    for (const rel of mainFiles) {
      const raw = read(rel);
      if (!raw.includes(DEV_SPKI)) continue;
      if (!/\.(java|kt)$/.test(rel)) {
        hits.push(`${rel}: dev SPKI in a resource (ships in release)`);
        continue;
      }
      const src = stripComments(raw);
      const ranges = [];
      for (const m of src.matchAll(/\bif\s*\(\s*BuildConfig\s*\.\s*DEBUG\s*\)\s*\{/g)) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        for (let k = open; k < src.length; k++) {
          if (src[k] === "{") depth++;
          else if (src[k] === "}" && --depth === 0) {
            ranges.push([open, k]);
            break;
          }
        }
      }
      let idx = src.indexOf(DEV_SPKI);
      while (idx !== -1) {
        if (!ranges.some(([a, b]) => idx > a && idx < b)) {
          hits.push(`${rel}:${lineOf(src, idx)}: dev SPKI outside if (BuildConfig.DEBUG)`);
        }
        idx = src.indexOf(DEV_SPKI, idx + 1);
      }
    }
    if (!swiftFiles.length) hits.push(`${IOS_APP}: no Swift sources (vacuous scan)`);
  }
  report(
    "the dev SPKI ships only inside #if DEBUG (Swift) / if (BuildConfig.DEBUG) (Android)",
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// c. No private-key material outside .env.dev
{
  const hits = [];
  const B64 = "[A-Za-z0-9+/_-]";
  const SHAPES = [
    ["pkcs8-ec-base64", new RegExp(`MIG${B64}AgEAMBMGByqGSM49AgEG${B64}{40,}`)],
    ["pkcs8-ec-base64", new RegExp(`MII${B64}{2}AgEAMBMGByqGSM49AgEG${B64}{40,}`)],
    ["sec1-ec-base64", new RegExp(`MHcCAQEEI${B64}{40,}`)],
    ["pkcs8-ec-hex", /308187020100301306072a8648ce3d020106082a8648ce3d030107[0-9a-f]{40,}/i],
  ];
  let scanned = 0;
  for (const rel of repoFiles()) {
    let buf;
    try {
      buf = readFileSync(abs(rel));
    } catch {
      continue;
    }
    if (buf.length > 8 * 1024 * 1024 || buf.includes(0)) continue;
    scanned++;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [name, re] of SHAPES) {
        if (!re.test(line)) continue;
        if (rel === ENV_DEV && /^APP_UPDATE_SIGNING_KEY_BASE64=/.test(line)) continue;
        hits.push(`${rel}:${i + 1}: ${name}`);
      }
    });
  }
  if (scanned < 50) hits.push(`only ${scanned} files scanned (vacuous scan)`);
  report(
    `no EC private-key material (PKCS#8 / SEC1, base64 or hex) in ${scanned} repo files except ${ENV_DEV} APP_UPDATE_SIGNING_KEY_BASE64`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// d. Env files
{
  const hits = [];
  const envVal = (rel) => {
    const ms = [...read(rel).matchAll(/^APP_UPDATE_SIGNING_KEY_BASE64=(.*)$/gm)];
    if (ms.length !== 1) {
      hits.push(
        `${rel}: APP_UPDATE_SIGNING_KEY_BASE64= must appear exactly once (found ${ms.length})`,
      );
      return null;
    }
    return ms[0][1].trim();
  };
  const ex = envVal(ENV_EXAMPLE);
  if (ex !== null && ex !== "")
    hits.push(`${ENV_EXAMPLE}: APP_UPDATE_SIGNING_KEY_BASE64 is not empty`);
  const dev = envVal(ENV_DEV);
  if (dev === "") hits.push(`${ENV_DEV}: APP_UPDATE_SIGNING_KEY_BASE64 is empty`);
  else if (dev) {
    try {
      const key = createPrivateKey({
        key: Buffer.from(dev, "base64"),
        format: "der",
        type: "pkcs8",
      });
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        hits.push(`${ENV_DEV}: APP_UPDATE_SIGNING_KEY_BASE64 is not an EC P-256 key`);
      } else {
        const spki = createPublicKey(key)
          .export({ format: "der", type: "spki" })
          .toString("base64");
        if (spki !== DEV_SPKI)
          hits.push(
            `${ENV_DEV}: APP_UPDATE_SIGNING_KEY_BASE64's public half is not APP_UPDATE_PUBLIC_KEYS.dev`,
          );
        if (keys.shared.prod && spki === keys.shared.prod.spki)
          hits.push(`${ENV_DEV}: APP_UPDATE_SIGNING_KEY_BASE64 is the PRODUCTION key`);
      }
    } catch {
      hits.push(`${ENV_DEV}: APP_UPDATE_SIGNING_KEY_BASE64 is not base64 PKCS#8 DER`);
    }
  }
  report(
    `APP_UPDATE_SIGNING_KEY_BASE64 is empty in ${ENV_EXAMPLE} and the dev key (public half = APP_UPDATE_PUBLIC_KEYS.dev) in ${ENV_DEV}`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// e. The api never logs the signature, the manifest or the key
// TypeScript lexer + bracket matcher (same as passkey-hygiene.mjs): `skel` = source with comments
// and the contents of strings / template literals / regex literals blanked (same length).
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
function splitTop(skel, a, b) {
  const parts = [];
  let depth = 0;
  let start = a;
  for (let k = a; k < b; k++) {
    const ch = skel[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  if (skel.slice(start, b).trim()) parts.push([start, b]);
  return parts;
}
const LOG_CALL =
  /(?<![\w$])(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*(?:log|logger|[A-Za-z_$][\w$]*(?:Log|Logger))\s*(?:\?\.|\.|\[\s*[A-Za-z_$][\w$]*\s*\]\s*)\s*(?:(trace|debug|info|warn|error|fatal|child)\s*)?\(/g;
const IDENT = /(?<![\w$])([A-Za-z_$][\w$]*)/g;
const LITERAL = /^\s*(?:"\s*"|'\s*'|`\s*`)\s*$/;
const SECRET_IDENT =
  /signature|manifestjson|manifest_json|signingkey|signing_key|privatekey|private_key|pkcs8|keybase64|key_base64|spki|envelope/i;

function logCalls(rel, src, skel) {
  const out = [];
  const problems = [];
  for (const m of skel.matchAll(LOG_CALL)) {
    // `log[level](…)` (computed method) or `log.info(…)`; a bare `log(` is not a logger call.
    if (!m[1] && !/\[/.test(m[0])) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(skel, open);
    const where = `${rel}:${lineOf(src, m.index)}`;
    if (close < 0) {
      problems.push(`${where}: cannot parse logger call`);
      continue;
    }
    out.push({ where, args: splitTop(skel, open + 1, close) });
  }
  const consoles = [...skel.matchAll(/(?<![\w$.])console\s*\.\s*\w+\s*\(/g)].map(
    (m) => `${rel}:${lineOf(src, m.index)}: console call`,
  );
  return { calls: out, problems, consoles };
}
{
  const hits = [];
  const files = walk(API_SRC).filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".d.ts") &&
      !/\/(test|testing|__tests__)\//.test(f),
  );
  let calls = 0;
  let featureCalls = 0;
  const ALLOWED = new Set(["outcome", "status", "stale", "platform", "keyId"]);
  for (const rel of files) {
    const src = read(rel);
    const { skel } = lex(src);
    const { calls: found, problems, consoles } = logCalls(rel, src, skel);
    hits.push(...problems);
    const feature = rel.startsWith(`${API_APP_UPDATE}/`);
    if (feature) hits.push(...consoles);
    for (const c of found) {
      calls++;
      const seen = new Set();
      for (const [a, b] of c.args) {
        for (const im of skel.slice(a, b).matchAll(IDENT)) {
          if (!seen.has(im[1]) && SECRET_IDENT.test(im[1])) {
            seen.add(im[1]);
            hits.push(`${c.where}: logs ${im[1]}`);
          }
        }
      }
      if (!feature) continue;
      featureCalls++;
      if (c.args.length === 0) {
        hits.push(`${c.where}: logger call without arguments`);
        continue;
      }
      const [a0, b0] = c.args[0];
      const first = skel.slice(a0, b0);
      if (first.trim().startsWith("{")) {
        const o = a0 + first.indexOf("{");
        const oc = matchClose(skel, o);
        if (oc < 0 || oc > b0) {
          hits.push(`${c.where}: cannot parse the log object`);
          continue;
        }
        for (const [ka, kb] of splitTop(skel, o + 1, oc)) {
          const entry = skel.slice(ka, kb);
          if (/^\s*\.\.\./.test(entry)) {
            for (const km of entry.matchAll(/(?<![\w$.?])([A-Za-z_$][\w$]*)\s*:/g)) {
              if (!ALLOWED.has(km[1])) hits.push(`${c.where}: spread log key ${km[1]} not allowed`);
            }
            continue;
          }
          const km = /^\s*([A-Za-z_$][\w$]*)\s*(?::([\s\S]*))?$/.exec(entry);
          if (!km) {
            hits.push(`${c.where}: log object entry is not a plain key`);
            continue;
          }
          if (km[1] === "err") {
            if (!/^\s*safeErrorLog\s*\(/.test(km[2] ?? ""))
              hits.push(`${c.where}: err must be safeErrorLog(…)`);
          } else if (!ALLOWED.has(km[1])) {
            hits.push(`${c.where}: log key ${km[1]} is not one of ${[...ALLOWED].join("/")}/err`);
          }
        }
        for (const [a, b] of c.args.slice(1)) {
          if (!LITERAL.test(skel.slice(a, b)))
            hits.push(`${c.where}: message is not a string literal`);
        }
      } else {
        for (const [a, b] of c.args) {
          if (!LITERAL.test(skel.slice(a, b)))
            hits.push(`${c.where}: argument is neither a log object nor a string literal`);
        }
      }
    }
  }
  if (calls === 0) hits.push(`${API_SRC}: no logger call found (vacuous scan)`);
  if (featureCalls === 0) hits.push(`${API_APP_UPDATE}: no logger call found (vacuous scan)`);
  const tel = read(TELEMETRY);
  for (const k of ["signature", "manifestjson", "appupdatesigningkeybase64"]) {
    if (!new RegExp(`^\\s*"${k}",`, "m").test(tel))
      hits.push(`${TELEMETRY}: scrub key "${k}" missing`);
  }
  if (!/MIGHAgEAMBMGByqGSM49AgEG/.test(tel))
    hits.push(`${TELEMETRY}: no PKCS#8 EC key scrub pattern`);
  if (!/manifestJson\|APP_UPDATE_SIGNING_KEY_BASE64/.test(tel))
    hits.push(`${TELEMETRY}: no manifestJson / APP_UPDATE_SIGNING_KEY_BASE64 pair scrub`);
  report(
    `no api logger call (${calls} in ${files.length} files) logs a signature, manifest or key; app-update logs outcome fields only (${featureCalls}); telemetry scrubs them`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// f. The updater sources do not log
{
  const hits = [];
  const javaFiles = walk(JAVA_UPDATE).filter((f) => /\.(java|kt)$/.test(f));
  const RULES = [
    [
      SWIFT_UPDATER,
      /(?<![\w$.])(?:print|debugPrint|NSLog|os_log|os_signpost|dump)\s*\(|\bLogger\s*\(|\bCAPLog\b|\bOSLog\b|FileHandle\s*\.\s*standardError/,
    ],
    [
      javaFiles,
      /(?<![\w$])Log\s*\.\s*\w+\s*\(|System\s*\.\s*(?:out|err)\b|printStackTrace\s*\(|\bLogger\b|android\.util\.Log\b|java\.util\.logging/,
    ],
    [JS_UPDATER, /(?<![\w$.])console\s*\./],
  ];
  for (const [files, re] of RULES) {
    for (const rel of files) {
      const g = new RegExp(re.source, "g");
      const src = stripComments(read(rel));
      for (const m of src.matchAll(g)) hits.push(`${rel}:${lineOf(src, m.index)}: log call`);
    }
  }
  if (!javaFiles.length) hits.push(`${JAVA_UPDATE}: no sources (vacuous scan)`);
  report(
    `no log call in the updater sources (${SWIFT_UPDATER.length} Swift, ${javaFiles.length} Android, ${JS_UPDATER.length} TS)`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// g. No third-party updater dependency
{
  const hits = [];
  const pkgs = repoFiles().filter(
    (f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules/"),
  );
  const BAD = /^@capgo\/|^@ionic-enterprise\/|capacitor-updater|appflow/i;
  for (const rel of pkgs) {
    let pj;
    try {
      pj = JSON.parse(read(rel));
    } catch {
      hits.push(`${rel}: does not parse`);
      continue;
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(pj[field] ?? {})) {
        if (BAD.test(name)) hits.push(`${rel}: ${field} has ${name}`);
      }
    }
  }
  if (!pkgs.includes(WEB_PKG)) hits.push(`${WEB_PKG}: not in the scanned set`);
  report(
    `no @capgo/*, @ionic-enterprise/*, capacitor-updater or appflow dependency in ${pkgs.length} package.json files`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// h. Builds write the manifest
{
  const hits = [];
  const scripts = JSON.parse(read(WEB_PKG)).scripts ?? {};
  for (const s of ["build", "native:build", "native:build:release"]) {
    if (typeof scripts[s] !== "string") hits.push(`${WEB_PKG}: script ${s} missing`);
    else if (!/&&\s*node scripts\/app-update-manifest\.mjs dist\s*$/.test(scripts[s]))
      hits.push(
        `${WEB_PKG}: script ${s} does not end with "&& node scripts/app-update-manifest.mjs dist"`,
      );
  }
  report(
    `${WEB_PKG} build, native:build and native:build:release end with the manifest step`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// i. minNativeBuild vs the shells
{
  const hits = [];
  let au = null;
  try {
    au = JSON.parse(read(APP_UPDATE_JSON));
  } catch {
    hits.push(`${APP_UPDATE_JSON}: does not parse`);
  }
  if (au) {
    if (typeof au.webVersion !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(au.webVersion))
      hits.push(`${APP_UPDATE_JSON}: webVersion missing or invalid`);
    const mnb = au.minNativeBuild ?? {};
    for (const p of ["ios", "android"]) {
      if (!Number.isInteger(mnb[p]) || mnb[p] < 1)
        hits.push(`${APP_UPDATE_JSON}: minNativeBuild.${p} is not an integer >= 1`);
    }
    const iosBuilds = [...read(PBXPROJ).matchAll(/CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g)].map(
      (m) => m[1].trim(),
    );
    if (iosBuilds.length === 0) hits.push(`${PBXPROJ}: no CURRENT_PROJECT_VERSION`);
    for (const b of iosBuilds) {
      if (!/^\d+$/.test(b))
        hits.push(`${PBXPROJ}: CURRENT_PROJECT_VERSION ${b} is not a plain integer`);
      else if (Number.isInteger(mnb.ios) && mnb.ios > Number(b))
        hits.push(`${APP_UPDATE_JSON}: minNativeBuild.ios ${mnb.ios} > iOS build ${b}`);
    }
    const vc = /^\s*versionCode\s+(\d+)\s*$/m.exec(read(GRADLE));
    if (!vc) hits.push(`${GRADLE}: no plain versionCode`);
    else if (Number.isInteger(mnb.android) && mnb.android > Number(vc[1]))
      hits.push(`${APP_UPDATE_JSON}: minNativeBuild.android ${mnb.android} > versionCode ${vc[1]}`);
  }
  report(`${APP_UPDATE_JSON} parses and minNativeBuild <= the iOS / Android build numbers`, hits);
}

// ---------------------------------------------------------------------------------------------
// j. Build-time flags the OTA bundle inherits from the web image
{
  // Each is either identical for the web image and the native shells, or resolved for native at
  // runtime: VITE_API_URL (web image: PUBLIC_URL, native release: the same https origin),
  // VITE_APP_LINK_HOSTS / VITE_DEEPLINK_DEV_SCHEME (dev-only toggles, off in both release builds),
  // VITE_APP_VERSION (label; native shows info().nativeVersion), VITE_PUSH_ANDROID (fallback
  // only: Android reads info().androidPushConfigured), VITE_SENTRY_DSN (errors only, same DSN).
  const ALLOW = new Set([
    "VITE_API_URL",
    "VITE_APP_LINK_HOSTS",
    "VITE_APP_VERSION",
    "VITE_DEEPLINK_DEV_SCHEME",
    "VITE_PUSH_ANDROID",
    "VITE_SENTRY_DSN",
  ]);
  const hits = [];
  const files = walk(WEB_SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
  for (const rel of files) {
    const src = stripComments(read(rel));
    for (const m of src.matchAll(/\bVITE_[A-Z0-9_]+\b/g)) {
      if (!ALLOW.has(m[0]))
        hits.push(
          `${rel}:${lineOf(src, m.index)}: ${m[0]} is not in the OTA build-flag allow-list`,
        );
    }
  }
  report(
    `every VITE_* flag in ${WEB_SRC} (${files.length} files) is on the OTA build-flag allow-list`,
    hits,
  );
}

process.exit(failed ? 1 : 0);
