#!/usr/bin/env node
// Sentry hygiene (docs/plans/review-fixes.md 2.6, 2.14 "Sentry hygiene", D7, D8; task R.13). Run by
// the CI `check` job through .github/scripts/sentry-hygiene.sh and runnable locally from the repo
// root:
//
//   bash .github/scripts/sentry-hygiene.sh [--root <dir>]
//
// 1. Packages: no `@sentry/capacitor`, no replay, tracing or profiling package, no
//    `@opentelemetry/*` (nor Sentry's OTel bridge) as a DIRECT dependency in any package.json
//    (dependencies, devDependencies, optionalDependencies, peerDependencies, pnpm.overrides,
//    resolutions). The lockfile is deliberately not checked: @sentry/node pulls OpenTelemetry in
//    transitively, which is expected. The only Sentry packages allowed are @sentry/node and
//    @sentry/react; adding another one means reviewing it and extending SENTRY_ALLOWED below.
// 2. Every `Sentry.init(...)` in non-test source under apps/*/src and packages/*/src (namespace
//    imports under any alias, `const X = await import("@sentry/…")`, the `Sentry` binding of the
//    web app's dynamic import, and `init` imported by name are all recognised) passes options
//    that, read from the source:
//      - have `dataCollection: { … }` with every category off: userInfo, cookies, httpHeaders,
//        httpBodies, urlQueryParams, graphQL, genAI, databaseQueryData, queues,
//        stackFrameVariables, frameContextLines all present, and every leaf (also of any extra
//        key) is `false`, `0` or `[]` (Sentry 11 has no `sendDefaultPii`; `dataCollection` is
//        its replacement);
//      - `defaultIntegrations: false`, `tracesSampleRate: 0`, `beforeBreadcrumb` returning null;
//      - `beforeSend` is `scrubTelemetryEvent` (or `(e) => scrubTelemetryEvent(e)`), and the file
//        takes `scrubTelemetryEvent` from @littlelight/shared rather than defining its own;
//      - no tracesSampler/profiles*/replays* sampling, no `enableLogs: true`, no non-false
//        `sendDefaultPii`, and no replay/tracing/profiling/console/breadcrumbs/http/request-data
//        integration in `integrations`;
//      - in apps/mobile-web: the init is preceded, in the same function, by an early `return`
//        whose condition calls `isNative()` (the native apps ship no telemetry, D8).
//    The options may be inline, a `const` object, or the object returned by a local function
//    (the api/worker `sentryOptions()`); any other form fails as "cannot resolve".
//    At least one init must exist in each of apps/api, apps/worker and apps/mobile-web, so a
//    move or rename cannot turn the check into a silent pass.
//
// The source is read with a small lexer (comments, strings, template literals and regex literals
// are blanked before brackets are matched); TypeScript 7 ships no JS parser API and this keeps the
// script dependency-free. `--root` points the check at another tree (used for negative tests:
// copy the files, plant a violation, see it fail). Only Node built-ins.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) root = path.resolve(args[++i]);
  else {
    console.error("usage: sentry-hygiene.mjs [--root <dir>]");
    process.exit(2);
  }
}

const errors = [];
const fail = (msg) => errors.push(msg);

// ---------------------------------------------------------------------------------------------
// File list: git (tracked + untracked, not ignored) when root is a work tree, else a walk.
function listFiles() {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = out.split("\0").filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // not a git work tree: walk below
  }
  const files = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(root, rel))) {
      if (name === "node_modules" || name === ".git" || name === "dist") continue;
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(root, r)).isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk("");
  return files;
}

const all = listFiles().filter((f) => !f.split("/").includes("node_modules"));

// ---------------------------------------------------------------------------------------------
// 1. Direct dependencies.
const SENTRY_ALLOWED = new Set(["@sentry/node", "@sentry/react"]);
const FORBIDDEN = [
  [/^@sentry\/capacitor$/, "Sentry Capacitor SDK (the native apps ship no telemetry, D8)"],
  [/^@sentry(-internal)?\/.*replay/, "session replay"],
  [/^@sentry(-internal)?\/.*tracing/, "tracing"],
  [/^@sentry\/profiling/, "profiling"],
  [/^@sentry\/opentelemetry/, "Sentry's OpenTelemetry bridge"],
  [/^@opentelemetry\//, "OpenTelemetry (deferred, D8)"],
];
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "resolutions",
];
const manifests = all.filter((f) => f === "package.json" || f.endsWith("/package.json"));
if (!manifests.includes("package.json")) fail("root package.json not found (wrong --root?)");
for (const m of manifests) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, m), "utf8"));
  } catch (e) {
    fail(`${m}: cannot parse (${e.message})`);
    continue;
  }
  const names = [];
  for (const field of DEP_FIELDS) names.push(...Object.keys(pkg[field] ?? {}));
  names.push(...Object.keys(pkg.pnpm?.overrides ?? {}).map((k) => k.replace(/@[^@/]*$/, "")));
  for (const name of new Set(names)) {
    const hit = FORBIDDEN.find(([re]) => re.test(name));
    if (hit) fail(`${m}: forbidden package ${name} (${hit[1]})`);
    else if (/^@sentry(-internal)?\//.test(name) && !SENTRY_ALLOWED.has(name))
      fail(`${m}: ${name} is not an allowed Sentry package (${[...SENTRY_ALLOWED].join(", ")})`);
  }
}
console.log(`packages: ${manifests.length} package.json file(s) checked`);

// ---------------------------------------------------------------------------------------------
// Lexer: returns { code, skel } of the same length as src. `code` has comments blanked; `skel`
// additionally blanks the contents of strings, template literals and regex literals (delimiters
// kept), so bracket matching and token regexes on `skel` cannot be fooled by text.
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
  let lastSig = ""; // last significant (non-space, non-comment) char
  let lastSigPos = -1;
  const tmplStack = []; // brace depth at which each open `${` returns to its template
  let depth = 0;
  const readTemplate = (start) => {
    // start is just after a "`" or the "}" closing a ${...}; returns index after the closing "`",
    // or the index after "${" (pushing to tmplStack).
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
/** Index of the bracket closing the one at `open` (in skel), or -1. */
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
const nextSig = (s, k) => {
  while (k < s.length && /\s/.test(s[k])) k++;
  return k;
};

/** Top-level properties of the object literal whose `{` is at `open`: [{ key, value, vStart }]. */
function objectProps(f, open) {
  const close = matchClose(f.skel, open);
  if (close < 0) return null;
  const props = [];
  let start = open + 1;
  let depthHere = 0;
  const flush = (end) => {
    const raw = f.skel.slice(start, end);
    if (raw.trim()) {
      const lead = start + (raw.length - raw.trimStart().length);
      const seg = f.code.slice(lead, end);
      const m = /^(?:(["'])([^"']*)\1|([A-Za-z_$][\w$]*))\s*:/.exec(seg);
      if (m) {
        const vStart = nextSig(f.code, lead + m[0].length);
        props.push({ key: m[2] ?? m[3], value: f.code.slice(vStart, end).trim(), vStart });
      } else props.push({ key: null, value: seg.trim(), vStart: lead });
    }
    start = end + 1;
  };
  for (let k = open + 1; k < close; k++) {
    const ch = f.skel[k];
    if (OPEN[ch]) depthHere++;
    else if (ch === "}" || ch === ")" || ch === "]") depthHere--;
    else if (ch === "," && depthHere === 0) flush(k);
  }
  flush(close);
  return props;
}

/** Locate the body `{` of a function given the index of its parameter list `(`. */
function functionBodyOpen(skel, paramsOpen) {
  const pc = matchClose(skel, paramsOpen);
  if (pc < 0) return -1;
  let k = pc + 1;
  let prev = ")";
  while (k < skel.length) {
    const ch = skel[k];
    if (/\s/.test(ch)) {
      k++;
      continue;
    }
    if (ch === "{") {
      if (/[\w$)\]}>]/.test(prev)) return k;
      const e = matchClose(skel, k);
      if (e < 0) return -1;
      prev = "}";
      k = e + 1;
      continue;
    }
    if (ch === "(" || ch === "[") {
      const e = matchClose(skel, k);
      if (e < 0) return -1;
      prev = OPEN[ch];
      k = e + 1;
      continue;
    }
    if (ch === "=" && skel[k + 1] === ">") {
      // arrow: `=> {` body or `=> (` expression
      const s = nextSig(skel, k + 2);
      return skel[s] === "{" ? s : -1;
    }
    if (ch === ";") return -1;
    prev = ch;
    k++;
  }
  return -1;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolve the options argument text of an init call to the `{` of an object literal. */
function resolveOptions(f, argOpen, argClose) {
  const s = nextSig(f.skel, argOpen + 1);
  if (f.skel[s] === "{") return s;
  const arg = f.code.slice(s, argClose).trim();
  let m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(arg);
  if (m) {
    const name = escapeRe(m[1]);
    const decl = new RegExp(`\\bfunction\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`).exec(f.skel);
    let body = -1;
    if (decl) body = functionBodyOpen(f.skel, decl.index + decl[0].length - 1);
    else {
      const arrow = new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=]*=\\s*(?:async\\s*)?\\(`).exec(
        f.skel,
      );
      if (arrow) {
        const po = arrow.index + arrow[0].length - 1;
        const pc = matchClose(f.skel, po);
        const a = pc < 0 ? -1 : f.skel.indexOf("=>", pc);
        if (a >= 0) {
          const t = nextSig(f.skel, a + 2);
          if (f.skel[t] === "(" && f.skel[nextSig(f.skel, t + 1)] === "{")
            return nextSig(f.skel, t + 1);
          if (f.skel[t] === "{") body = t;
        }
      }
    }
    if (body < 0) return -1;
    const end = matchClose(f.skel, body);
    // first top-level `return {` / `return ({` in the body
    let depthHere = 0;
    for (let k = body + 1; k < end; k++) {
      const ch = f.skel[k];
      if (OPEN[ch]) depthHere++;
      else if (ch === "}" || ch === ")" || ch === "]") depthHere--;
      else if (depthHere === 0 && f.skel.startsWith("return", k) && !/[\w$]/.test(f.skel[k - 1])) {
        let t = nextSig(f.skel, k + 6);
        if (f.skel[t] === "(") t = nextSig(f.skel, t + 1);
        return f.skel[t] === "{" ? t : -1;
      }
    }
    return -1;
  }
  m = /^([A-Za-z_$][\w$]*)$/.exec(arg);
  if (m) {
    const v = new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(m[1])}\\b[^=]*=\\s*\\{`).exec(f.skel);
    if (v) return v.index + v[0].length - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// 2. Sentry.init call sites.
const SOURCE = /^(apps|packages)\/[^/]+\/src\/.+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|testing)\//;
const sources = all.filter((f) => SOURCE.test(f) && !TEST.test(f) && !/\.d\.ts$/.test(f));

const DATA_COLLECTION_KEYS = [
  "userInfo",
  "cookies",
  "httpHeaders",
  "httpBodies",
  "urlQueryParams",
  "graphQL",
  "genAI",
  "databaseQueryData",
  "queues",
  "stackFrameVariables",
  "frameContextLines",
];
const BAD_INTEGRATION =
  /\b\w*(replay|tracing|profil|console|breadcrumbs|httpIntegration|fetchIntegration|requestData|nodeFetch|undici|postgres|pg\w*Integration|fastify)\w*/i;

function checkDataCollection(f, where, open, prefix, out) {
  const props = objectProps(f, open);
  if (!props) return fail(`${where}: dataCollection${prefix} is not a parseable object`);
  for (const p of props) {
    if (!p.key) {
      fail(`${where}: dataCollection${prefix} has a spread/shorthand entry "${p.value}"`);
      continue;
    }
    const name = `${prefix}.${p.key}`;
    out.add(name);
    const v = p.value;
    if (v === "false" || v === "0" || /^\[\s*\]$/.test(v)) continue;
    if (v.startsWith("{")) {
      checkDataCollection(f, where, p.vStart, name, out);
      continue;
    }
    fail(`${where}: dataCollection${name} is "${v}" (must be false, 0 or [])`);
  }
}

const initsPerApp = { "apps/api": 0, "apps/worker": 0, "apps/mobile-web": 0 };
let initCount = 0;

for (const file of sources) {
  const text = readFileSync(path.join(root, file), "utf8");
  if (!/@sentry\//.test(text) && !/\bSentry\b/.test(text)) continue;
  const f = { ...lex(text), file };

  // Names that refer to the Sentry SDK namespace, and names bound to `init` itself.
  const ns = new Set(["Sentry"]);
  const initFns = new Set();
  for (const m of f.code.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+["']@sentry\/[^"']+["']/g))
    ns.add(m[1]);
  for (const m of f.code.matchAll(
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?import\(\s*["']@sentry\/[^"']+["']\s*\)/g,
  ))
    ns.add(m[1]);
  for (const m of f.code.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s+["']@sentry\/[^"']+["']/g,
  ))
    for (const part of m[1].split(",")) {
      const mm = /^\s*init(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (mm) initFns.add(mm[1] ?? "init");
    }

  const calls = [];
  for (const m of f.skel.matchAll(/(?<![\w$.])([\w$]+)\s*(?:\?\.|\.)\s*init\s*\(/g))
    if (ns.has(m[1])) calls.push(m.index + m[0].length - 1);
  for (const name of initFns)
    for (const m of f.skel.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, "g")))
      calls.push(m.index + m[0].length - 1);

  // A file that imports a Sentry SDK must not call `.init(` on anything we cannot attribute.
  if (/["']@sentry\//.test(f.code)) {
    for (const m of f.skel.matchAll(/(?<![\w$])([\w$]+)\s*(?:\?\.|\.)\s*init\s*\(/g))
      if (!ns.has(m[1]))
        fail(
          `${file}: unrecognised "${m[1]}.init(" in a file that imports Sentry (extend this check)`,
        );
  }

  for (const argOpen of calls) {
    initCount++;
    const line = f.skel.slice(0, argOpen).split("\n").length;
    const where = `${file}:${line}`;
    const app = Object.keys(initsPerApp).find((a) => file.startsWith(`${a}/`));
    if (app) initsPerApp[app]++;
    const argClose = matchClose(f.skel, argOpen);
    if (argClose < 0) {
      fail(`${where}: unbalanced Sentry init call`);
      continue;
    }
    const objOpen = resolveOptions(f, argOpen, argClose);
    if (objOpen < 0) {
      fail(`${where}: cannot resolve the Sentry init options to an object literal`);
      continue;
    }
    const props = objectProps(f, objOpen);
    if (!props) {
      fail(`${where}: Sentry init options are not a parseable object`);
      continue;
    }
    const get = (k) => props.find((p) => p.key === k);
    for (const p of props)
      if (!p.key && p.value.startsWith("..."))
        fail(`${where}: spread "${p.value}" in the Sentry options (keep every option explicit)`);

    // dataCollection
    const dc = get("dataCollection");
    if (!dc) fail(`${where}: no dataCollection block (Sentry 11: every category must be off)`);
    else if (!dc.value.startsWith("{")) fail(`${where}: dataCollection is not an inline object`);
    else {
      const seen = new Set();
      checkDataCollection(f, where, dc.vStart, "", seen);
      for (const k of DATA_COLLECTION_KEYS)
        if (!seen.has(`.${k}`)) fail(`${where}: dataCollection.${k} is not set (must be off)`);
    }

    if (get("defaultIntegrations")?.value !== "false")
      fail(`${where}: defaultIntegrations must be false`);
    if (get("tracesSampleRate")?.value !== "0") fail(`${where}: tracesSampleRate must be 0`);

    const bs = get("beforeSend")?.value ?? "";
    const bsOk =
      bs === "scrubTelemetryEvent" ||
      /^(?:async\s*)?\(?\s*([\w$]+)\s*(?::[^,)]*)?(?:,\s*[\w$]+\s*(?::[^,)]*)?)?\)?\s*=>\s*scrubTelemetryEvent\(\s*\1\s*\)$/.test(
        bs.replace(/\s+/g, " "),
      );
    if (!bsOk) fail(`${where}: beforeSend must be scrubTelemetryEvent (found "${bs || "none"}")`);
    if (!/["']@littlelight\/shared["']/.test(f.code) || !/\bscrubTelemetryEvent\b/.test(f.code))
      fail(`${where}: scrubTelemetryEvent is not taken from @littlelight/shared`);
    if (
      /\b(?:function\s+scrubTelemetryEvent|(?:const|let|var)\s+scrubTelemetryEvent\s*=)/.test(
        f.skel,
      )
    )
      fail(`${where}: defines its own scrubTelemetryEvent (use the shared one)`);

    const bb = (get("beforeBreadcrumb")?.value ?? "").replace(/\s+/g, " ");
    if (!/^\(?[^)]*\)? ?=> ?\(?null\)?$/.test(bb))
      fail(`${where}: beforeBreadcrumb must return null (found "${bb || "none"}")`);

    for (const k of ["tracesSampler", "profilesSampler", "tracePropagationTargets"])
      if (get(k)) fail(`${where}: ${k} must not be set`);
    for (const k of [
      "profilesSampleRate",
      "profileSessionSampleRate",
      "replaysSessionSampleRate",
      "replaysOnErrorSampleRate",
    ]) {
      const v = get(k)?.value;
      if (v !== undefined && v !== "0") fail(`${where}: ${k} must be 0 or unset`);
    }
    for (const k of ["sendDefaultPii", "enableLogs"]) {
      const v = get(k)?.value;
      if (v !== undefined && v !== "false") fail(`${where}: ${k} must be false or unset`);
    }
    const integ = get("integrations")?.value;
    if (integ) {
      const bad = BAD_INTEGRATION.exec(integ);
      if (bad) fail(`${where}: integration "${bad[0]}" is not allowed (errors only)`);
    }

    // Web: native apps never initialise (an early return on isNative() before the init).
    if (file.startsWith("apps/mobile-web/")) {
      const before = f.skel.slice(0, argOpen);
      const fnStart = Math.max(
        before.lastIndexOf("function "),
        before.lastIndexOf("function("),
        before.lastIndexOf("=>"),
      );
      let guarded = false;
      for (const m of f.skel.slice(fnStart, argOpen).matchAll(/\bif\s*\(/g)) {
        const co = fnStart + m.index + m[0].length - 1;
        const cc = matchClose(f.skel, co);
        if (cc < 0 || cc > argOpen) continue;
        const cond = f.skel.slice(co, cc + 1);
        const t = nextSig(f.skel, cc + 1);
        const thenReturns =
          f.skel.startsWith("return", t) ||
          (f.skel[t] === "{" && f.skel.startsWith("return", nextSig(f.skel, t + 1)));
        if (/\bisNative\s*\(\s*\)/.test(cond) && !/!\s*isNative/.test(cond) && thenReturns)
          guarded = true;
      }
      if (!guarded)
        fail(`${where}: web Sentry init is not preceded by an early return on isNative()`);
    }
  }
}

for (const [app, n] of Object.entries(initsPerApp))
  if (n === 0)
    fail(`${app}: no Sentry init found under ${app}/src (moved? the check would be vacuous)`);
console.log(`inits: ${initCount} Sentry init call(s) checked in ${sources.length} source file(s)`);

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error(`sentry hygiene: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(
  "sentry hygiene OK: no replay/tracing/OTel/Capacitor package; every init errors-only, scrubbed",
);
