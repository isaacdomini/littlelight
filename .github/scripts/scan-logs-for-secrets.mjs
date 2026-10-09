#!/usr/bin/env node
// Push/native log scan (docs/plans/step-9.md 9.16 and 2.15 "Push gate": "worker/api logs contain
// no device token, `eyJ`, or `X-Amz-Signature`"). CI runs it on the api + worker logs the
// log tap (.github/scripts/log-tap.sh) captured across the push gate's container recreations;
// runnable locally on any saved log files:
//
//   node .github/scripts/scan-logs-for-secrets.mjs [--require <regex>]... <file|dir>...
//
// Directories are read for *.log files (not recursive). The gate itself also checks the exact
// random tokens it generated; this scan has no access to those, so it looks for anything
// token-shaped instead:
//   jwt         eyJ... (access/refresh/viewer JWTs, id tokens)
//   presign     X-Amz-Signature / X-Amz-Credential (presigned URL parts)
//   bearer      "Bearer <value>" (an Authorization header)
//   apns-token  a free-standing 64-hex-digit string (APNs device token shape)
//   fcm-token   an FCM registration token (`<id>:APA91b...`)
//   token-field a token-carrying field with a real value: token, deviceToken, device_token,
//               pushToken, registrationToken, fcmToken, apnsToken, refreshToken, accessToken,
//               idToken (pino's "[redacted]" censor and empty values are fine; counters such
//               as `inputTokens` do not match)
// Only file:line and the pattern name are printed, never the matching text. `--require` makes the
// scan non-vacuous: each regex must match somewhere in the scanned logs (e.g. `push\.notify`
// proves the worker's push jobs ran while the tap was on). ANSI colour codes are stripped first.
// Only Node built-ins.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const required = [];
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--require") {
    const re = args[++i];
    if (!re) usage();
    required.push(new RegExp(re));
  } else inputs.push(args[i]);
}
if (inputs.length === 0) usage();

function usage() {
  console.error("usage: scan-logs-for-secrets.mjs [--require <regex>]... <file|dir>...");
  process.exit(2);
}

const PATTERNS = [
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}/],
  ["presign", /X-Amz-(Signature|Credential)/i],
  ["bearer", /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/-]{16,}/i],
  ["apns-token", /(?<![0-9A-Za-z])[0-9a-fA-F]{64}(?![0-9A-Za-z])/],
  ["fcm-token", /[A-Za-z0-9_-]{11,}:APA91b[A-Za-z0-9_-]{20,}/],
  [
    "token-field",
    /(?<![A-Za-z0-9_])(token|device_?token|push_?token|registration_?token|fcm_?token|apns_?token|refresh_?token|access_?token|id_?token)["']?\s*[:=]\s*(?!["']?\[redacted\])(?!["']?\s*[,}\]]|\s*$)["']?[^\s"',}]/i,
  ],
];

const files = [];
for (const p of inputs) {
  let st;
  try {
    st = statSync(p);
  } catch {
    console.error(`::error::${p} does not exist`);
    process.exit(1);
  }
  if (st.isDirectory()) {
    for (const n of readdirSync(p).sort()) if (n.endsWith(".log")) files.push(path.join(p, n));
  } else files.push(p);
}
if (files.length === 0) {
  console.error(`::error::no log files in ${inputs.join(", ")}`);
  process.exit(1);
}

// ESC built from its code so the source holds no control character (biome noControlCharactersInRegex).
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const hits = [];
const found = new Array(required.length).fill(false);
let bytes = 0;
let lines = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8").replace(ansi, "");
  bytes += text.length;
  const rows = text.split("\n");
  lines += rows.length;
  rows.forEach((row, i) => {
    for (const [name, re] of PATTERNS) if (re.test(row)) hits.push(`${f}:${i + 1}: ${name}`);
    required.forEach((re, k) => {
      if (!found[k] && re.test(row)) found[k] = true;
    });
  });
}

console.log(`scanned ${files.length} file(s), ${lines} lines, ${bytes} bytes`);
let fail = false;
if (hits.length > 0) {
  for (const h of hits.slice(0, 50)) console.error(h);
  console.error(
    `::error::${hits.length} token-shaped value(s) in the logs (locations above; values not printed)`,
  );
  fail = true;
}
required.forEach((re, k) => {
  if (!found[k]) {
    console.error(`::error::required pattern /${re.source}/ not found: the scan would be vacuous`);
    fail = true;
  }
});
if (fail) process.exit(1);
console.log(`ok: no JWT, presign part, bearer, APNs/FCM token or token field in the logs`);
