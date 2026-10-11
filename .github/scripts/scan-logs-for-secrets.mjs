#!/usr/bin/env node
// Push/native and data-export log scan (docs/plans/step-9.md 9.16 and 2.15 "Push gate": "worker/api
// logs contain no device token, `eyJ`, or `X-Amz-Signature`"; docs/plans/review-fixes.md 2.14
// "Export gate"). CI runs it on the api + worker logs the log tap (.github/scripts/log-tap.sh)
// captured across the push gate's and the export gate's container recreations/restarts;
// runnable locally on any saved log files:
//
//   node .github/scripts/scan-logs-for-secrets.mjs [--pii] [--require <regex>]... <file|dir>...
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
// Data-export patterns (docs/plans/review-fixes.md 2.3 "Logging", 2.14 "Export gate"; R.13):
//   coordinate  a decimal coordinate pair `-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}`. To keep
//               false positives low, each number must stand alone (no letter, digit, `_` or dot
//               either side, so timestamps, versions and long floats do not match), the pair
//               must be a valid lat/lng in either order (|lat| <= 90, |lng| <= 180), and a pair
//               right after a timing key (any key containing time/timing/duration/elapsed/
//               latency, e.g. responseTime, or ending in Ms/_ms) is ignored: those are
//               measurements, not places.
//   lat-lng     a latitude/longitude field with a numeric value, JSON (`"gps_lat": 40.7`) or
//               pino-pretty (`lat: 40.7`) form: lat, lng, latitude, longitude, gps_lat, gps_lng
//               (a "[redacted]" censor, null or a boolean such as `includeLocation` is fine)
//   export-key  a data-export object key `babies/<uuid>/exports/<uuid>.zip` (also URL-encoded)
// Photo-import patterns (docs/plans/step-10.md 2.3 TELEMETRY_SCRUB_PATTERNS, 2.9, 4.3 step 10;
// task 10.14), for the import gate's api + worker + google-fake logs:
//   google-access-token   `ya29.<8+ base64url>` (a real Google OAuth access token)
//   google-refresh-token  `1//<8+ base64url>` not preceded by a word char, `/` or `:` (so `http://`,
//                         `v1//` and `:1//` paths do not match)
//   google-auth-code      `4/0A<20+ base64url>` (a real Google authorization code)
//   fake-google-token     `fake-access-…`, `fake-refresh-…`, `fake-code-…` (the fake's token shapes)
//   google-media-url      `googleusercontent.com/<path>` (a Picker baseUrl; the bare host name, e.g.
//                         a configured host suffix, is fine)
//   picker-url            `photospicker.googleapis.com/v1/sessions|mediaItems/…`,
//                         `photos.google.com/picker/…`, or a fake `/picker/<session id>` path
//   fake-media-path       `/media/<item id>` (the fake's baseUrl path; no api route has it)
//   picker-uri-field      a `pickerUri` / `baseUrl` field with a real value (a "[redacted]" censor,
//                         null or empty is fine)
//   native-upload-path    `ll-uploads/<file>` (the iOS upload cache)
// Personal data, opt-in with `--pii` (docs/plans/step-11.md 4.3 / 4.4 step 8, task 11.9b; the
// abuse gate's api + worker logs). Not on by default: the other gates' logs were never held to it.
//   email     an email address `local@domain.tld` (alphabetic TLD of 2+ letters, so package
//             specifiers such as `pino@9.1.0` do not match; `[redacted]` is fine)
//   ipv4      a free-standing dotted quad (each octet 0-255, no digit, letter or dot either side)
//             other than 0.0.0.0 and 127.x.x.x, on a line that is not a server's "listening"
//             line (Fastify prints its bind addresses at start-up; no request is behind those)
// Only file:line and the pattern name are printed, never the matching text. `--require` makes the
// scan non-vacuous: each regex must match somewhere in the scanned logs (e.g. `push\.notify`
// proves the worker's push jobs ran while the tap was on). ANSI colour codes are stripped first.
// Only Node built-ins.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const required = [];
const inputs = [];
let pii = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pii") pii = true;
  else if (args[i] === "--require") {
    const re = args[++i];
    if (!re) usage();
    required.push(new RegExp(re));
  } else inputs.push(args[i]);
}
if (inputs.length === 0) usage();

function usage() {
  console.error("usage: scan-logs-for-secrets.mjs [--pii] [--require <regex>]... <file|dir>...");
  process.exit(2);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COORD_PAIR = /(?<![\w.])(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})(?![\w.])/g;
const TIMING_KEY =
  /(?:\w*(?:time|timing|duration|elapsed|latency)\w*|\w*Ms|\w*_ms)["']?\s*[:=]\s*\[?\s*$/i;
/** True when `row` holds a plausible latitude/longitude pair (see the header). */
function coordinatePair(row) {
  for (const m of row.matchAll(COORD_PAIR)) {
    const a = Math.abs(Number(m[1]));
    const b = Math.abs(Number(m[2]));
    if (!((a <= 90 && b <= 180) || (a <= 180 && b <= 90))) continue;
    if (TIMING_KEY.test(row.slice(Math.max(0, m.index - 48), m.index))) continue;
    return true;
  }
  return false;
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
  ["coordinate", { test: coordinatePair }],
  [
    "lat-lng",
    /(?<![A-Za-z0-9_])["']?(lat|lng|latitude|longitude|gps_lat|gps_lng)["']?\s*[:=]\s*["']?-?\d/i,
  ],
  ["export-key", new RegExp(`babies(?:/|%2F)${UUID}(?:/|%2F)exports(?:/|%2F)${UUID}\\.zip`, "i")],
  ["google-access-token", /(?<![A-Za-z0-9_])ya29\.[A-Za-z0-9_-]{8,}/],
  ["google-refresh-token", /(?<![\w/:])1\/\/[A-Za-z0-9_-]{8,}/],
  ["google-auth-code", /(?<![\w/.])4\/0A[A-Za-z0-9_-]{20,}/],
  ["fake-google-token", /(?<![A-Za-z0-9_])fake-(?:access|refresh|code)-[A-Za-z0-9_-]{4,}/],
  ["google-media-url", /googleusercontent\.com(?::\d+)?\/(?!\[redacted\])[^\s"'<>]+/i],
  [
    "picker-url",
    /photospicker\.googleapis\.com\/v1\/(?:sessions|mediaItems)[/?][^\s"'<>]|photos\.google\.com\/picker\/[^\s"'<>]|\/picker\/[A-Za-z0-9_-]{6,}/i,
  ],
  ["fake-media-path", /\/media\/[A-Za-z0-9][\w-]*/],
  [
    "picker-uri-field",
    /(?<![A-Za-z0-9_])["']?(pickerUri|baseUrl|picker_uri|base_url)["']?\s*[:=]\s*(?!["']?\[redacted\])(?!["']?\s*[,}\]]|\s*$|null\b)["']?[^\s"',}]/i,
  ],
  ["native-upload-path", /(?<![\w-])ll-uploads\/[^\s"'<>]+/],
];

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\w)/g;
/** True when `row` holds a client-IP-shaped dotted quad (see the header). */
function ipv4(row) {
  if (/listening/i.test(row)) return false;
  for (const m of row.matchAll(IPV4)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) continue;
    if (o[0] === 127 || o.every((x) => x === 0)) continue;
    return true;
  }
  return false;
}
if (pii) {
  PATTERNS.push(
    [
      "email",
      /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/,
    ],
    ["ipv4", { test: ipv4 }],
  );
}

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
    `::error::${hits.length} ${pii ? "sensitive" : "token-shaped"} value(s) in the logs (locations above; values not printed)`,
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
console.log(
  `ok: no JWT, presign part, bearer, APNs/FCM token, token field, coordinate, lat/lng value, export key, Google/fake token or code, media/picker URL or upload-cache path${pii ? ", email address or IPv4 address" : ""} in the logs`,
);
