#!/usr/bin/env node
// Video hygiene, static part (docs/plans/step-12.md 2.10 "video-hygiene.sh", 2.6; task 12.11).
// Run by .github/scripts/video-hygiene.sh and runnable on its own from the repo root:
//
//   node .github/scripts/video-hygiene.mjs [--root <dir>]
//
//  a. No web scheme name in apps/worker/src/video (every non-test .ts, comments included):
//     `grep -r http apps/worker/src/video` is empty. ffmpeg/ffprobe only ever get staged local
//     files, never a URL (the tests that exercise the URL refusal are excluded by name).
//  b. One spawn site: apps/worker/src/video/ffmpeg.ts is the only file under apps/worker/src/video
//     and apps/worker/src/demo that imports node:child_process (spawn/exec*/fork), it exports
//     `assertLocalArgs`, and inside `runProcess` the call `assertLocalArgs(args)` precedes the
//     `spawn(` call; every other video/demo file that runs a binary does so through
//     `runProcess(` (at least one caller outside ffmpeg.ts, non-vacuous).
//  c. Logger calls in apps/worker/src/video (non-test) carry ids, outcomes, counts, durations
//     and booleans only: no identifier, object key or property segment in a logger call's
//     arguments whose camel/snake word is one of path(s), file(s), filename, basename, dir(s),
//     directory, scratch, stderr, stdout, tail, tag(s), lat, lng, lon, latitude, longitude,
//     coord(s), coordinate(s), location, gps, iso6709, url(s), uri, make, model, creation,
//     taken, exif, raw, text, message, msg, output, args, argv, cmd, command, source, src, dest,
//     destination, target, title, note(s), caption. The root of a property chain is not judged
//     (`probe.hdr`, `staged.bytes`, `err.reason`, `matcher.name` are fine; `staged.path` is
//     not), nor is a boolean-shaped identifier (`takenAtEstimated`, `isX`, `hasX`). An
//     `err` entry must be `errorCategory(…)` or `safeErrorLog(…)` (a category, never the error
//     text); no `${…}` interpolation and every message is a string literal; no console.*. At
//     least one logger call (non-vacuous).
//  d. Migration 22 (packages/db/migrations/1792500000100_video.sql): the UP body of
//     `jsonb_has_gps_keys` matches `location` and `iso6709` (the QuickTime GPS tag names), so
//     `photo_exif.raw_json` can never carry a clip's location tag (the `photo_exif_no_gps_keys`
//     tripwire fires).
//  e. docker-compose.yml `worker`: `mem_limit: 3g`, and a bind volume whose source is the
//     required `${WORKER_SCRATCH_PATH:?…}`, target `/scratch`, `create_host_path: false`.
//  f. .env.example sets `WORKER_SCRATCH_PATH=` (an active line, not a comment).
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
    console.error("usage: video-hygiene.mjs [--root <dir>]");
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

const VIDEO = "apps/worker/src/video";
const DEMO = "apps/worker/src/demo";
const FFMPEG = `${VIDEO}/ffmpeg.ts`;
const MIGRATION = "packages/db/migrations/1792500000100_video.sql";
const COMPOSE_PROD = "docker-compose.yml";
const ENV_EXAMPLE = ".env.example";

const missing = [
  ...[VIDEO, DEMO].filter((d) => !isDir(d)),
  ...[FFMPEG, MIGRATION, COMPOSE_PROD, ENV_EXAMPLE].filter((f) => !isFile(f)),
];
if (missing.length) {
  for (const m of missing) console.error(`::error::${m} is missing`);
  process.exit(1);
}

/** Non-test .ts files under `rel` (recursive; node_modules/dist skipped). */
function sources(rel) {
  const out = [];
  for (const name of readdirSync(abs(rel)).sort()) {
    const child = `${rel}/${name}`;
    if (isDir(child)) {
      if (!["node_modules", "dist"].includes(name)) out.push(...sources(child));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(child);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TypeScript lexer, bracket matcher (same as abuse-hygiene.mjs / passkey-hygiene.mjs): { code,
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
/** A string literal (contents blanked in skel) or a template literal without interpolation. */
const LITERAL = /^\s*(?:"\s*"|'\s*'|`\s*`)\s*$/;
/** Identifier chains `a.b.c` / `a?.b` (optional chaining tolerated). */
const CHAIN = /(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/g;
const words = (id) =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_$]+/)
    .filter(Boolean);
const FORBIDDEN_WORDS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filename",
  "basename",
  "dir",
  "dirs",
  "directory",
  "scratch",
  "stderr",
  "stdout",
  "tail",
  "tag",
  "tags",
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "coord",
  "coords",
  "coordinate",
  "coordinates",
  "location",
  "gps",
  "iso6709",
  "url",
  "urls",
  "uri",
  "make",
  "model",
  "creation",
  "taken",
  "exif",
  "raw",
  "text",
  "message",
  "msg",
  "output",
  "args",
  "argv",
  "cmd",
  "command",
  "source",
  "src",
  "dest",
  "destination",
  "target",
  "title",
  "note",
  "notes",
  "caption",
]);
/** Boolean-shaped names (`takenAtEstimated`, `isRemux`, `hasAudio`) carry no value worth hiding. */
const booleanShaped = (ws) => ws.includes("estimated") || ws[0] === "is" || ws[0] === "has";
const forbiddenWord = (id) => {
  const ws = words(id);
  return booleanShaped(ws) ? undefined : ws.find((w) => FORBIDDEN_WORDS.has(w));
};

// ---------------------------------------------------------------------------------------------
// a. No web scheme name in the video module
{
  const hits = [];
  for (const rel of sources(VIDEO)) {
    const src = read(rel);
    for (const m of src.matchAll(/http/gi))
      hits.push(`${rel}:${lineOf(src, m.index)}: mentions a web scheme`);
  }
  report(`no "http" anywhere in ${VIDEO} (non-test files, comments included)`, hits);
}

// ---------------------------------------------------------------------------------------------
// b. One spawn site, guarded by assertLocalArgs; everything else goes through runProcess
{
  const hits = [];
  const files = [...sources(VIDEO), ...sources(DEMO)];
  let callers = 0;
  for (const rel of files) {
    const src = read(rel);
    const { code, skel } = lex(src);
    const importsChild = /child_process/.test(code);
    const spawns = [
      ...skel.matchAll(
        /(?<![\w$.])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g,
      ),
    ];
    if (rel !== FFMPEG) {
      if (importsChild) hits.push(`${rel}: imports node:child_process (only ${FFMPEG} may)`);
      for (const m of spawns)
        hits.push(`${rel}:${lineOf(src, m.index)}: ${m[1]}( outside ${FFMPEG}`);
      callers += [...skel.matchAll(/(?<![\w$.])runProcess\s*\(/g)].length;
      continue;
    }
    if (!importsChild) hits.push(`${rel}: does not import node:child_process (moved?)`);
    if (!/export\s+function\s+assertLocalArgs\s*\(/.test(code)) {
      hits.push(`${rel}: no exported assertLocalArgs()`);
    }
    const run = /(?:export\s+)?async\s+function\s+runProcess\s*\(/.exec(code);
    if (!run) hits.push(`${rel}: no runProcess()`);
    else {
      const bodyOpen = skel.indexOf("{", skel.indexOf(")", run.index));
      const bodyClose = matchClose(skel, bodyOpen);
      const body = bodyClose > 0 ? skel.slice(bodyOpen, bodyClose) : "";
      const guard = body.search(/(?<![\w$.])assertLocalArgs\s*\(\s*args\s*\)/);
      const sp = body.search(/(?<![\w$.])spawn\s*\(/);
      if (guard < 0) hits.push(`${rel}: runProcess() does not call assertLocalArgs(args)`);
      if (sp < 0) hits.push(`${rel}: runProcess() does not spawn`);
      if (guard >= 0 && sp >= 0 && guard > sp)
        hits.push(`${rel}: assertLocalArgs(args) comes after spawn( in runProcess()`);
    }
    const outside = spawns.filter((m) => {
      const bodyOpen = run ? skel.indexOf("{", skel.indexOf(")", run.index)) : -1;
      const bodyClose = bodyOpen >= 0 ? matchClose(skel, bodyOpen) : -1;
      return !(m.index > bodyOpen && m.index < bodyClose);
    });
    for (const m of outside)
      hits.push(`${rel}:${lineOf(src, m.index)}: ${m[1]}( outside runProcess()`);
  }
  if (callers === 0)
    hits.push(`${VIDEO}, ${DEMO}: no runProcess( caller outside ${FFMPEG} (vacuous)`);
  report(
    `ffmpeg/ffprobe are spawned only in ${FFMPEG} runProcess(), after assertLocalArgs(args); ${callers} runProcess( caller(s) elsewhere`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// c. Logger calls in the video module: ids, outcomes, counts, durations, booleans only
{
  const hits = [];
  let calls = 0;
  for (const rel of sources(VIDEO)) {
    const src = read(rel);
    const { skel } = lex(src);
    for (const m of skel.matchAll(/(?<![\w$.])console\s*\.\s*\w+\s*\(/g)) {
      hits.push(`${rel}:${lineOf(src, m.index)}: console call`);
    }
    for (const m of skel.matchAll(LOG_CALL)) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(skel, open);
      const where = `${rel}:${lineOf(src, m.index)}`;
      if (close < 0) {
        hits.push(`${where}: cannot parse logger call`);
        continue;
      }
      calls++;
      const argsSkel = skel.slice(open + 1, close);
      if (argsSkel.includes("${")) hits.push(`${where}: template interpolation in a log argument`);
      const parts = splitTop(skel, open + 1, close);
      parts.forEach(([a, b], idx) => {
        const text = skel.slice(a, b);
        if (idx > 0 || !text.trim().startsWith("{")) {
          if (!LITERAL.test(text))
            hits.push(
              `${where}: argument ${idx + 1} is neither the log object nor a string literal`,
            );
          return;
        }
        const seen = new Set();
        for (const c of text.matchAll(CHAIN)) {
          const segs = c[0].split(/\s*\??\.\s*/);
          const judged = segs.length > 1 ? segs.slice(1) : segs;
          for (const seg of judged) {
            const w = forbiddenWord(seg);
            if (w && !seen.has(seg)) {
              seen.add(seg);
              hits.push(`${where}: logs ${seg} (${w})`);
            }
          }
        }
        if (
          /(?<![\w$.])err\s*(?::|,|\})/.test(text) &&
          !/(?<![\w$.])err\s*:\s*(?:errorCategory|safeErrorLog)\s*\(/.test(text)
        ) {
          hits.push(`${where}: err must be errorCategory(…) or safeErrorLog(…)`);
        }
      });
    }
  }
  if (calls === 0) hits.push(`${VIDEO}: no logger call (vacuous scan)`);
  report(
    `logger calls in ${VIDEO} (${calls}) carry ids, outcomes, counts, durations and booleans only (no paths, tags, coordinates, stderr)`,
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// d. Migration 22: jsonb_has_gps_keys matches the QuickTime location keys
{
  const hits = [];
  const src = read(MIGRATION);
  const downAt = src.search(/^--\s*Down Migration/m);
  const up = downAt >= 0 ? src.slice(0, downAt) : src;
  if (downAt < 0) hits.push(`${MIGRATION}: no "-- Down Migration" marker`);
  const fn =
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.jsonb_has_gps_keys[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(
      up,
    );
  if (!fn) hits.push(`${MIGRATION}: UP part does not redefine public.jsonb_has_gps_keys`);
  else {
    const re = /like_regex\s+"([^"]+)"/i.exec(fn[1]);
    if (!re) hits.push(`${MIGRATION}: jsonb_has_gps_keys has no like_regex`);
    else {
      for (const word of ["location", "iso6709"]) {
        if (!re[1].toLowerCase().includes(word))
          hits.push(`${MIGRATION}: jsonb_has_gps_keys regex lacks ${word}`);
      }
      if (!/flag\s+"i"/i.test(fn[1]))
        hits.push(`${MIGRATION}: jsonb_has_gps_keys regex is not case-insensitive`);
    }
  }
  report(
    "migration 22 makes jsonb_has_gps_keys match location / ISO6709 (QuickTime GPS tags)",
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// e. docker-compose.yml worker: mem_limit 3g and the required /scratch bind
{
  const hits = [];
  const lines = read(COMPOSE_PROD).split("\n");
  const start = lines.findIndex((l) => /^ {2}worker:\s*$/.test(l));
  if (start < 0) hits.push(`${COMPOSE_PROD}: no worker service`);
  else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z_-]+:\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const block = lines.slice(start, end);
    if (!block.some((l) => /^\s+mem_limit:\s*3g\s*$/.test(l)))
      hits.push(`${COMPOSE_PROD}: worker mem_limit is not 3g`);
    const srcIdx = block.findIndex((l) => /^\s+source:\s*\$\{WORKER_SCRATCH_PATH:\?/.test(l));
    if (srcIdx < 0)
      hits.push(`${COMPOSE_PROD}: worker has no bind with source \${WORKER_SCRATCH_PATH:?…}`);
    else {
      // The volume entry: from its `- type:` line to the next `- ` entry or the end of `volumes:`.
      let a = srcIdx;
      while (a > 0 && !/^\s+-\s+type:/.test(block[a])) a--;
      let b = srcIdx + 1;
      while (b < block.length && !/^\s+-\s+/.test(block[b]) && !/^\s{4}[A-Za-z_]+:/.test(block[b]))
        b++;
      const entry = block.slice(a, b).join("\n");
      if (!/^\s+target:\s*\/scratch\s*$/m.test(entry))
        hits.push(`${COMPOSE_PROD}: WORKER_SCRATCH_PATH bind target is not /scratch`);
      if (!/^\s+create_host_path:\s*false\s*$/m.test(entry))
        hits.push(`${COMPOSE_PROD}: WORKER_SCRATCH_PATH bind lacks create_host_path: false`);
      if (/read_only:\s*true/.test(entry))
        hits.push(`${COMPOSE_PROD}: WORKER_SCRATCH_PATH bind is read-only`);
    }
    if (!block.some((l) => /^\s+WORKER_SCRATCH_PATH:\s*\/scratch\s*$/.test(l))) {
      hits.push(`${COMPOSE_PROD}: worker env WORKER_SCRATCH_PATH is not /scratch`);
    }
  }
  report(
    "docker-compose.yml worker has mem_limit 3g and the required WORKER_SCRATCH_PATH bind at /scratch (create_host_path: false)",
    hits,
  );
}

// ---------------------------------------------------------------------------------------------
// f. .env.example documents WORKER_SCRATCH_PATH
{
  const hits = [];
  if (!/^WORKER_SCRATCH_PATH=\S+/m.test(read(ENV_EXAMPLE)))
    hits.push(`${ENV_EXAMPLE}: no active WORKER_SCRATCH_PATH= line`);
  report(".env.example sets WORKER_SCRATCH_PATH", hits);
}

process.exit(failed ? 1 : 0);
