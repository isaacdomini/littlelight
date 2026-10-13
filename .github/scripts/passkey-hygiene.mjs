#!/usr/bin/env node
// Passkey hygiene, static part (docs/plans/step-13.md 2.7 "passkey-hygiene.sh", 2.4; task 13.8).
// Run by .github/scripts/passkey-hygiene.sh and runnable on its own from the repo root:
//
//   node .github/scripts/passkey-hygiene.mjs [--root <dir>]
//
//  a. apps/api/src/auth/passkeys.ts and apps/api/src/auth/webauthn.ts log outcomes only. Every
//     logger call there (`request.log.info(`, `log.warn(`, `app.log.error(`, `logger.child(` …)
//     has as its first argument either a string literal (the fixed message) or an object literal
//     whose keys are only `outcome`, `status`, `code`, `error_code`, `context` (a string literal,
//     number, or a plain identifier / property chain that names none of the forbidden things
//     below) or `err` whose value is a `safeErrorLog(…)` call; every further argument is a string
//     literal. No console.* call. At least one logger call per file (non-vacuous).
//  b. No WebAuthn credential field reaches any logger call in apps/api/src (every .ts file except
//     tests and test support): no identifier, object key or property in a logger call's arguments
//     contains clientDataJSON, attestationObject, authenticatorData, signature, rawId, userHandle,
//     challenge (also challengeId / challenge_id and the snake_case forms), credential, or the
//     request body/headers (`body`, `headers`). String literals are ignored (a message may say
//     "challenge expired"; a value never travels in one).
//  c. The api logger's redact list (apps/api/src/app.ts, `redact: { paths: [...] }`) censors the
//     credential JSON and the challenge id wherever they appear: `req.body.credential`,
//     `req.body.challengeId`, and the wildcard paths `*.credential`, `*.challengeId`,
//     `*.challenge_id`, `*.clientDataJSON`, `*.attestationObject`, `*.authenticatorData`,
//     `*.signature`, `*.rawId`, `*.userHandle`.
//  d. The feature flag defaults off in production and on in dev: docker-compose.yml passes
//     `GOTRUE_PASSKEY_ENABLED: ${AUTH_PASSKEYS_ENABLED:-false}` to auth and
//     `AUTH_PASSKEYS_ENABLED: ${AUTH_PASSKEYS_ENABLED:-false}` to api (and never `:-true`);
//     docker-compose.dev.yml defines the shared anchor as `${AUTH_PASSKEYS_ENABLED:-true}` and
//     both GOTRUE_PASSKEY_ENABLED (auth) and AUTH_PASSKEYS_ENABLED (api) take it, so GoTrue and
//     the api can never disagree.
//  e. GoTrue's passkey routes stay unreachable from browsers: the `$ll_auth_allowed` map in
//     docker/nginx/default.conf allows exactly `GET /auth/(health|authorize|callback)` and
//     `POST /auth/callback` and mentions no passkey path.
//
// Every path the checks read must exist, so a move or rename fails instead of passing silently.
// `--root` points the checks at a copy of the tree (negative tests: copy, plant a violation, see
// it fail). Prints locations and rule names only, never file contents. Only Node built-ins.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) root = path.resolve(args[++i]);
  else {
    console.error("usage: passkey-hygiene.mjs [--root <dir>]");
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

const API_SRC = "apps/api/src";
const PASSKEY_FILES = [`${API_SRC}/auth/passkeys.ts`, `${API_SRC}/auth/webauthn.ts`];
const APP = `${API_SRC}/app.ts`;
const COMPOSE_PROD = "docker-compose.yml";
const COMPOSE_DEV = "docker-compose.dev.yml";
const NGINX = "docker/nginx/default.conf";

const missing = [
  ...[API_SRC].filter((d) => !isDir(d)),
  ...[...PASSKEY_FILES, APP, COMPOSE_PROD, COMPOSE_DEV, NGINX].filter((f) => !isFile(f)),
];
if (missing.length) {
  for (const m of missing) console.error(`::error::${m} is missing`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// TypeScript lexer, bracket matcher (same as abuse-hygiene.mjs / import-hygiene.mjs): { code,
// skel } of the same length as src. `code` has comments blanked; `skel` additionally blanks the
// contents of strings, template literals (the `${…}` interpolations stay) and regex literals.
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

/** Top-level comma split of s[a, b) by a bracket-aware scan of `skel`. Returns [start, end). */
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
  /(?<![\w$])(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*(?:log|logger|[A-Za-z_$][\w$]*(?:Log|Logger))\s*(?:\?\.|\.)\s*(trace|debug|info|warn|error|fatal|child)\s*\(/g;
const IDENT = /(?<![\w$])([A-Za-z_$][\w$]*)/g;
/** A string literal (contents blanked in skel) or a template literal without interpolation. */
const LITERAL = /^\s*(?:"\s*"|'\s*'|`\s*`)\s*$/;
/** WebAuthn credential material and request carriers that may never be logged (identifier names). */
const FORBIDDEN =
  /clientdatajson|client_data_json|attestationobject|attestation_object|authenticatordata|authenticator_data|signature|rawid|raw_id|userhandle|user_handle|challenge|credential|^body$|^headers$|^req$|^request$|token|cookie|secret|password|e_?mail/i;

/** Every logger call in a lexed file: { where, open, close, args: [[a,b]...] }. */
function logCalls(rel, src, { code, skel }) {
  const out = [];
  const problems = [];
  for (const m of skel.matchAll(LOG_CALL)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(skel, open);
    const where = `${rel}:${lineOf(src, m.index)}`;
    if (close < 0) {
      problems.push(`${where}: cannot parse logger call`);
      continue;
    }
    out.push({ where, open, close, args: splitTop(skel, open + 1, close), method: m[1] });
  }
  for (const m of skel.matchAll(/(?<![\w$.])console\s*\.\s*\w+\s*\(/g)) {
    problems.push(`${rel}:${lineOf(src, m.index)}: console call`);
  }
  void code;
  return { calls: out, problems };
}

// ---------------------------------------------------------------------------------------------
// a. passkeys.ts / webauthn.ts: outcome-only logging
{
  const ALLOWED = new Set(["outcome", "status", "code", "error_code", "context"]);
  const hits = [];
  let calls = 0;
  for (const rel of PASSKEY_FILES) {
    const src = read(rel);
    const lexed = lex(src);
    const { skel } = lexed;
    const { calls: found, problems } = logCalls(rel, src, lexed);
    hits.push(...problems);
    if (found.length === 0) hits.push(`${rel}: no logger call (vacuous scan)`);
    for (const c of found) {
      calls++;
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
          const km = /^\s*([A-Za-z_$][\w$]*)\s*(?::([\s\S]*))?$/.exec(entry);
          if (!km) {
            hits.push(`${c.where}: log object entry is not a plain key (spread or computed)`);
            continue;
          }
          const key = km[1];
          const value = km[2] === undefined ? key : km[2];
          if (key === "err") {
            if (!/^\s*safeErrorLog\s*\(/.test(value)) {
              hits.push(`${c.where}: err must be safeErrorLog(…)`);
            }
            continue;
          }
          if (!ALLOWED.has(key)) {
            hits.push(
              `${c.where}: log object key ${key} is not one of outcome/status/code/error_code/context/err`,
            );
            continue;
          }
          for (const im of value.matchAll(IDENT)) {
            if (FORBIDDEN.test(im[1])) hits.push(`${c.where}: ${key} is computed from ${im[1]}`);
          }
          if (/\(/.test(value))
            hits.push(`${c.where}: ${key} is a call result (log a literal or a plain field)`);
        }
        for (const [a, b] of c.args.slice(1)) {
          if (!LITERAL.test(skel.slice(a, b)))
            hits.push(`${c.where}: message is not a string literal`);
        }
      } else {
        for (const [a, b] of c.args) {
          if (!LITERAL.test(skel.slice(a, b))) {
            hits.push(`${c.where}: argument is neither a log object nor a string literal`);
          }
        }
      }
    }
  }
  report(
    `logger calls in passkeys.ts and webauthn.ts (${calls}) carry only outcome/status/code/context and fixed messages`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// b. No credential field in any api logger call
{
  const files = [];
  const walk = (rel) => {
    for (const name of readdirSync(abs(rel)).sort()) {
      const child = `${rel}/${name}`;
      if (isDir(child)) {
        if (!["node_modules", "dist", "test", "testing", "__tests__"].includes(name)) walk(child);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        files.push(child);
      }
    }
  };
  walk(API_SRC);
  const FIELD =
    /clientdatajson|client_data_json|attestationobject|attestation_object|authenticatordata|authenticator_data|signature|rawid|raw_id|userhandle|user_handle|challenge|credential|^body$|^headers$/i;
  const hits = [];
  let calls = 0;
  for (const rel of files) {
    const src = read(rel);
    const lexed = lex(src);
    const { calls: found, problems } = logCalls(rel, src, lexed);
    hits.push(...problems.filter((p) => !p.endsWith("console call")));
    for (const c of found) {
      calls++;
      const seen = new Set();
      for (const [a, b] of c.args) {
        for (const im of lexed.skel.slice(a, b).matchAll(IDENT)) {
          const id = im[1];
          if (!seen.has(id) && FIELD.test(id)) {
            seen.add(id);
            hits.push(`${c.where}: logs ${id}`);
          }
        }
      }
    }
  }
  if (calls === 0) hits.push(`${API_SRC}: no logger call found (vacuous scan)`);
  report(
    `no WebAuthn credential field, challenge, credential, body or headers in any api logger call (${calls} calls in ${files.length} files)`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// c. app.ts redact list
{
  const src = read(APP);
  const { code, skel } = lex(src);
  const hits = [];
  const m = /redact\s*:\s*\{[\s\S]*?paths\s*:\s*\[/.exec(skel);
  if (!m) hits.push(`${APP}: no redact.paths list`);
  else {
    const open = m.index + m[0].length - 1;
    const close = matchClose(skel, open);
    if (close < 0) hits.push(`${APP}: cannot parse redact.paths`);
    else {
      const body = code.slice(open + 1, close);
      const present = new Set([...body.matchAll(/(["'])([^"'\n]+)\1/g)].map((x) => x[2]));
      const REQUIRED = [
        "req.body.credential",
        "req.body.challengeId",
        "*.credential",
        "*.challengeId",
        "*.challenge_id",
        "*.clientDataJSON",
        "*.attestationObject",
        "*.authenticatorData",
        "*.signature",
        "*.rawId",
        "*.userHandle",
      ];
      for (const r of REQUIRED)
        if (!present.has(r)) hits.push(`${APP}: redact path ${r} is missing`);
    }
  }
  report("the api logger redacts the credential JSON, its fields and the challenge id", hits);
}

// ---------------------------------------------------------------------------------------------
// d. Feature flag defaults: production off, dev on, GoTrue and api on the same value
{
  const hits = [];
  const prod = read(COMPOSE_PROD);
  const dev = read(COMPOSE_DEV);
  const has = (src, re, what, rel) => {
    if (!re.test(src)) hits.push(`${rel}: ${what}`);
  };
  has(
    prod,
    /^\s*GOTRUE_PASSKEY_ENABLED:\s*\$\{AUTH_PASSKEYS_ENABLED:-false\}\s*$/m,
    "auth must get GOTRUE_PASSKEY_ENABLED from AUTH_PASSKEYS_ENABLED with the default false",
    COMPOSE_PROD,
  );
  has(
    prod,
    /^\s*AUTH_PASSKEYS_ENABLED:\s*\$\{AUTH_PASSKEYS_ENABLED:-false\}\s*$/m,
    "api must get AUTH_PASSKEYS_ENABLED from AUTH_PASSKEYS_ENABLED with the default false",
    COMPOSE_PROD,
  );
  if (/AUTH_PASSKEYS_ENABLED:-true/.test(prod)) {
    hits.push(`${COMPOSE_PROD}: passkeys default on (AUTH_PASSKEYS_ENABLED:-true)`);
  }
  has(
    dev,
    /&dev-passkeys-enabled\s+\$\{AUTH_PASSKEYS_ENABLED:-true\}\s*$/m,
    "x-dev-shared must define the &dev-passkeys-enabled anchor as AUTH_PASSKEYS_ENABLED with the default true",
    COMPOSE_DEV,
  );
  has(
    dev,
    /^\s*GOTRUE_PASSKEY_ENABLED:\s*\*dev-passkeys-enabled\s*$/m,
    "auth must take GOTRUE_PASSKEY_ENABLED from *dev-passkeys-enabled",
    COMPOSE_DEV,
  );
  has(
    dev,
    /^\s*AUTH_PASSKEYS_ENABLED:\s*\*dev-passkeys-enabled\s*$/m,
    "api must take AUTH_PASSKEYS_ENABLED from *dev-passkeys-enabled",
    COMPOSE_DEV,
  );
  if (/AUTH_PASSKEYS_ENABLED:-false/.test(dev)) {
    hits.push(`${COMPOSE_DEV}: passkeys default off (AUTH_PASSKEYS_ENABLED:-false)`);
  }
  report(
    "AUTH_PASSKEYS_ENABLED defaults false in docker-compose.yml and true in docker-compose.dev.yml, on auth and api alike",
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// e. nginx allow-list unchanged (no passkey path reachable from browsers)
{
  const src = read(NGINX);
  const hits = [];
  const m = /map\s+"\$request_method \$uri"\s+\$ll_auth_allowed\s*\{/.exec(src);
  if (!m) hits.push(`${NGINX}: no $ll_auth_allowed map`);
  else {
    const open = m.index + m[0].length - 1;
    const close = src.indexOf("}", open);
    const body = src.slice(open + 1, close);
    if (/passkey/i.test(body)) hits.push(`${NGINX}: $ll_auth_allowed mentions a passkey path`);
    const allowed = body
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => /\s1;$/.test(l));
    const expected = ['"~^GET /auth/(?:health|authorize|callback)$"', '"POST /auth/callback"'];
    const got = allowed.map((l) => l.replace(/\s+1;$/, ""));
    if (got.length !== expected.length || expected.some((e, i) => got[i] !== e)) {
      hits.push(
        `${NGINX}: $ll_auth_allowed allows ${got.length} rule(s), expected exactly the two step-3 rules`,
      );
    }
    if (!/default\s+0;/.test(body)) hits.push(`${NGINX}: $ll_auth_allowed default is not 0`);
  }
  report(
    "nginx forwards only GET /auth/health|authorize|callback and POST /auth/callback to GoTrue",
    hits,
  );
}

process.exit(failed ? 1 : 0);
