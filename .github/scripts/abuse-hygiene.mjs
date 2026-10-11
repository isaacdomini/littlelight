#!/usr/bin/env node
// Free-tier abuse hygiene, static part (docs/plans/step-11.md 2.10 "abuse-hygiene.sh", family
// model; tasks 11.7, 11.7b). Run by .github/scripts/abuse-hygiene.sh (which adds the disposable-list
// rebuild diff) and runnable on its own from the repo root:
//
//   node .github/scripts/abuse-hygiene.mjs [--root <dir>]
//
//  a. Family-start ledger privacy contract. Every `CREATE TABLE … family_starts (…)` and `ALTER
//     TABLE … family_starts …` in packages/db/migrations (comments ignored; at least one CREATE must
//     exist) defines no column that could hold an email, a user agent or a raw IP: no column
//     name containing `mail`, `agent` or `ua` as a word, none with `ip`/`ips`/`ipv4`/`ipv6`,
//     `addr`/`address` or `remote` as a word except exactly `ip_hash` and `ip_country`, and no
//     column of type inet / cidr / macaddr (also via ALTER COLUMN … TYPE). `ip_hash` is a bytea
//     with an `octet_length(ip_hash) = 32` check (a digest, never the address).
//  b. (abuse-hygiene.sh) blocklist.generated.ts equals a fresh `disposable:build`.
//  c. Vendored list provenance: apps/api/src/auth/disposable/ has LICENSE.txt naming CC0 (the
//     upstream license), a non-empty disposable_email_blocklist.conf, build.ts and
//     blocklist.generated.ts.
//  d. No email, IP, IP hash, canonical email or token reaches a log line in the sign-in and
//     family-start code: apps/api/src/auth/{family-guards,session,routes,ip-hash}.ts and
//     apps/api/src/routes/babies.ts (required), context.ts (when present). No console.* call there. Every logger call (`log.warn(`,
//     `request.log.info(`, `app.log.error(`, `logger.child(` …) has arguments with no identifier
//     (keys, values, property reads, template interpolations alike; string literals are ignored,
//     message text is fixed) that names an email (`email`, `existingEmail`, `mail`), a canonical
//     email (`canonical…`), a token, cookie, secret or passcode, or an IP (`ip`, `clientIp`,
//     `ipHash`, `hashFamilyIp`, `remoteAddress`, …: any camel/snake word `ip`/`ips`/`ipv4`/`ipv6`),
//     nor any local variable assigned from `clientIp(`, `.ip`, `.ips`, `remoteAddress`, a
//     `hash…Ip(` / `…IpHash(` call, `familyStartGuards(` (its result carries the IP hash) or a
//     CF-Connecting-IP / X-Forwarded-For / X-Real-IP header read. At least
//     one logger call must exist in the scanned files (non-vacuous).
//  e. The abuse report never compares photos across accounts (user constraint): no `sha256` or
//     `phash` (any case, comments included) in packages/db/src/tools/abuse-report.ts, and no
//     `content_hash` or `embedding` in its code (comments excluded).
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
    console.error("usage: abuse-hygiene.mjs [--root <dir>]");
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

const MIGRATIONS = "packages/db/migrations";
const AUTH = "apps/api/src/auth";
const DISPOSABLE = `${AUTH}/disposable`;
const REPORT = "packages/db/src/tools/abuse-report.ts";
const BABIES_ROUTE = "apps/api/src/routes/babies.ts";
const AUTH_REQUIRED = [
  ...["family-guards.ts", "session.ts", "routes.ts", "ip-hash.ts"].map((f) => `${AUTH}/${f}`),
  BABIES_ROUTE,
];
const AUTH_OPTIONAL = ["context.ts"].map((f) => `${AUTH}/${f}`);
const VENDORED = ["LICENSE.txt", "disposable_email_blocklist.conf", "build.ts"].map(
  (f) => `${DISPOSABLE}/${f}`,
);
const GENERATED = `${DISPOSABLE}/blocklist.generated.ts`;

const missing = [
  ...[MIGRATIONS].filter((d) => !isDir(d)),
  ...[...AUTH_REQUIRED, ...VENDORED, GENERATED, REPORT].filter((f) => !isFile(f)),
];
if (missing.length) {
  for (const m of missing) console.error(`::error::${m} is missing`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// TypeScript lexer, bracket matcher (same as import-hygiene.mjs / sentry-hygiene.mjs): { code,
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

// ---------------------------------------------------------------------------------------------
// SQL skeleton: comments and the contents of '…', "…" (identifiers keep their text) and $tag$…$tag$
// bodies blanked to spaces (same length as the input), so keyword regexes and paren matching run
// on code only.
function sqlSkel(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "-" && d === "-") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === "'") {
      let k = i + 1;
      while (k < n) {
        if (src[k] === "'" && src[k + 1] === "'") k += 2;
        else if (src[k] === "'") break;
        else k++;
      }
      blank(i + 1, k);
      i = k + 1;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (!m) {
        i++;
        continue;
      }
      const e = src.indexOf(m[0], i + m[0].length);
      const end = e === -1 ? n : e;
      blank(i + m[0].length, end);
      i = end === n ? n : end + m[0].length;
    } else {
      i++;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// a. Family-start ledger privacy contract
{
  const what =
    "family_starts has no email, user-agent or raw-IP column (ip_hash is a 32-byte bytea digest)";
  const hits = [];
  const TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?family_starts"?`;
  const CREATE = new RegExp(
    String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}\s*\(`,
    "gi",
  );
  const ALTER = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE}(?![\w$])([^;]*)`,
    "gi",
  );
  const NOT_A_COLUMN = /^(constraint|primary|unique|check|foreign|exclude|like)$/i;
  const ALLOWED = new Set(["ip_hash", "ip_country"]);
  const BAD_TYPE = /^(inet|cidr|macaddr8?)$/i;
  const unquote = (s) => s.replace(/^"|"$/g, "").toLowerCase();
  const badName = (name) => {
    if (ALLOWED.has(name)) return null;
    const words = name.split(/_+/);
    if (/mail|agent/.test(name) || words.includes("ua")) return "an email or user agent";
    if (words.some((w) => /^(ips?|ipv[46]|addr|address|remote)$/.test(w))) return "an IP";
    return null;
  };
  let creates = 0;
  let ipHashOk = false;
  const files = readdirSync(abs(MIGRATIONS)).filter((f) => f.endsWith(".sql"));
  for (const f of files.sort()) {
    const rel = `${MIGRATIONS}/${f}`;
    const src = read(rel);
    const skel = sqlSkel(src);
    const col = (where, name, type) => {
      const n = unquote(name);
      const why = badName(n);
      if (why) hits.push(`${where}: column ${n} could hold ${why}`);
      if (type && BAD_TYPE.test(type)) hits.push(`${where}: column ${n} has type ${type}`);
    };
    for (const m of skel.matchAll(CREATE)) {
      creates++;
      const open = m.index + m[0].length - 1;
      const close = matchClose(skel, open);
      const where = `${rel}:${lineOf(src, m.index)}`;
      if (close < 0) {
        hits.push(`${where}: cannot parse CREATE TABLE family_starts`);
        continue;
      }
      const body = skel.slice(open + 1, close);
      for (const [a, b] of splitTop(skel, open + 1, close)) {
        const def = skel.slice(a, b).trim();
        const t = /^("[^"]+"|[A-Za-z_][\w$]*)\s+("[^"]+"|[A-Za-z_][\w$]*)/.exec(def);
        if (!t || NOT_A_COLUMN.test(t[1])) continue;
        col(`${rel}:${lineOf(src, a + skel.slice(a, b).search(/\S/))}`, t[1], t[2]);
        if (unquote(t[1]) === "ip_hash" && /^bytea$/i.test(t[2])) {
          if (/\boctet_length\s*\(\s*"?ip_hash"?\s*\)\s*=\s*32\b/i.test(body)) ipHashOk = true;
        }
      }
    }
    for (const m of skel.matchAll(ALTER)) {
      const where = `${rel}:${lineOf(src, m.index)}`;
      const body = m[1];
      for (const a of body.matchAll(
        /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+("[^"]+"|[A-Za-z_][\w$]*)/gi,
      )) {
        if (!NOT_A_COLUMN.test(a[1])) col(where, a[1], a[2]);
      }
      for (const a of body.matchAll(
        /\bRENAME\s+(?:COLUMN\s+)?\S+\s+TO\s+("[^"]+"|[A-Za-z_][\w$]*)/gi,
      )) {
        col(where, a[1], null);
      }
      for (const a of body.matchAll(
        /\bALTER\s+(?:COLUMN\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+(?:SET\s+DATA\s+)?TYPE\s+("[^"]+"|[A-Za-z_][\w$]*)/gi,
      )) {
        col(where, a[1], a[2]);
        if (unquote(a[1]) === "ip_hash" && !/^bytea$/i.test(a[2])) {
          hits.push(`${where}: ip_hash changed to type ${a[2]}`);
        }
      }
    }
  }
  if (creates === 0) hits.push(`${MIGRATIONS}: no CREATE TABLE family_starts found`);
  else if (!ipHashOk) {
    hits.push(
      `${MIGRATIONS}: family_starts.ip_hash is not a bytea with octet_length(ip_hash) = 32`,
    );
  }
  report(what, hits);
}

// ---------------------------------------------------------------------------------------------
// c. Vendored disposable-domain list provenance
{
  const hits = [];
  if (!/\bCC0\b/.test(read(`${DISPOSABLE}/LICENSE.txt`))) {
    hits.push(`${DISPOSABLE}/LICENSE.txt: does not name the CC0 license`);
  }
  const conf = read(`${DISPOSABLE}/disposable_email_blocklist.conf`)
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (conf.length === 0) hits.push(`${DISPOSABLE}/disposable_email_blocklist.conf: no domains`);
  report(
    "the vendored disposable-domain list has its CC0 LICENSE.txt, the .conf, build.ts and the generated module",
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// d. No email / IP / IP hash / token in the sign-in and family-start code's log lines
{
  const files = [...AUTH_REQUIRED, ...AUTH_OPTIONAL.filter(isFile)];
  const LOG_CALL =
    /(?<![\w$])(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*(?:log|logger|[A-Za-z_$][\w$]*(?:Log|Logger))\s*(?:\?\.|\.)\s*(trace|debug|info|warn|error|fatal|child)\s*\(/g;
  const IDENT = /(?<![\w$])([A-Za-z_$][\w$]*)/g;
  const words = (id) =>
    id
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase()
      .split(/[_$]+/)
      .filter(Boolean);
  const why = (id) => {
    const lower = id.toLowerCase();
    if (/e_?mail/.test(lower)) return "an email";
    if (lower.includes("canonical")) return "a canonical email";
    if (/token|authorization|cookie|bearer|secret|passcode|password/.test(lower)) {
      return "a token or secret";
    }
    const w = words(id);
    if (w.some((x) => /^(ips?|ipv[46])$/.test(x)) || /remoteaddress|forwardedfor/.test(lower)) {
      return "an IP or IP hash";
    }
    return null;
  };
  // Sources of a client IP (or its hash) whose results must not be logged under any name:
  // clientIp(…), any hash…Ip(…) / …IpHash(…) helper (hashFamilyIp, familyIpHash, …), and
  // familyStartGuards(…), whose result carries the IP hash.
  const IP_SOURCE_SKEL =
    /(?<![\w$])(?:clientIp|hash[A-Za-z]*Ip|[A-Za-z]*IpHash|familyStartGuards)\s*\(|\.\s*ips?(?![\w$])|remoteAddress/;
  const IP_SOURCE_CODE = /cf-connecting-ip|x-forwarded-for|x-real-ip/i;
  const hits = [];
  let calls = 0;
  for (const f of files) {
    const src = read(f);
    const { code, skel } = lex(src);
    for (const m of skel.matchAll(/(?<![\w$.])console\s*\.\s*\w+\s*\(/g)) {
      hits.push(`${f}:${lineOf(src, m.index)}: console call`);
    }
    // Locals assigned from an IP source (`const ip = clientIp(request)`, `let h = hashFamilyIp(…)`,
    // `const { ip: addr } = request` is caught by the `ip` word itself).
    const tainted = new Set();
    for (const m of skel.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/g)) {
      const start = m.index + m[0].length;
      let end = start;
      let depth = 0;
      for (; end < skel.length; end++) {
        const ch = skel[end];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (depth === 0) break;
          depth--;
        } else if ((ch === ";" || ch === "\n") && depth === 0) {
          if (ch === ";" || !/[=+\-*/?:.,(]\s*$/.test(skel.slice(start, end))) break;
        }
      }
      if (
        IP_SOURCE_SKEL.test(skel.slice(start, end)) ||
        IP_SOURCE_CODE.test(code.slice(start, end))
      ) {
        tainted.add(m[1]);
      }
    }
    for (const m of skel.matchAll(LOG_CALL)) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(skel, open);
      const where = `${f}:${lineOf(src, m.index)}`;
      if (close < 0) {
        hits.push(`${where}: cannot parse logger call`);
        continue;
      }
      calls++;
      const argsSkel = skel.slice(open + 1, close);
      if (IP_SOURCE_CODE.test(code.slice(open + 1, close))) {
        hits.push(`${where}: logs a client-IP header`);
      }
      const seen = new Set();
      for (const a of argsSkel.matchAll(IDENT)) {
        const id = a[1];
        if (seen.has(id)) continue;
        const reason = tainted.has(id) ? "a value derived from the client IP" : why(id);
        if (reason) {
          seen.add(id);
          hits.push(`${where}: logs ${id} (${reason})`);
        }
      }
    }
  }
  if (calls === 0) hits.push(`${AUTH}: no logger call in ${files.join(", ")} (vacuous scan)`);
  report(
    `logger calls in the sign-in and family-start code (${calls} in ${files.length} files) carry no email, IP, IP hash or token`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// e. The abuse report never compares photo content across accounts
{
  const src = read(REPORT);
  const { code } = lex(src);
  const hits = [];
  for (const m of src.matchAll(/sha256|phash/gi)) {
    hits.push(`${REPORT}:${lineOf(src, m.index)}: mentions ${m[0]}`);
  }
  for (const m of code.matchAll(/content_hash|embedding/gi)) {
    hits.push(`${REPORT}:${lineOf(src, m.index)}: uses ${m[0]}`);
  }
  report(
    "the abuse report has no sha256 / phash / content_hash / embedding (no cross-account photo comparison)",
    hits,
  );
}

process.exit(failed ? 1 : 0);
