#!/bin/sh
# Store-review sign-in (docs/plans/step-9.md 2.5, D4): makes the static 6-digit code that App
# Review / Play "App access" use, and the REVIEW_ACCOUNT_CODE_HASH the api checks it against.
# Same format and parameters as share-link passcodes (apps/api/src/sharing/crypto.ts
# hashPasscode): scrypt$1$16384$8$1$<salt b64url>$<key b64url>.
#
#   sh docker/tools/review-code-hash.sh            # random code
#   sh docker/tools/review-code-hash.sh --stdin    # hash a code you type (not echoed)
#
# Prints the code (keep it in your password manager and paste it into the store review notes;
# it is never stored anywhere else) and the line to add to the api's env (.env on the server,
# .env.local in dev). Uses a local `node` if present, otherwise the node:22-alpine image.
# Nothing is written to disk.
set -eu

mode="random"
if [ "${1:-}" = "--stdin" ]; then mode="stdin"; fi

js='
const c = require("node:crypto");
const run = (code) => {
  if (!/^[0-9]{6}$/.test(code)) { console.error("The code must be exactly 6 digits."); process.exit(1); }
  const salt = c.randomBytes(16);
  const key = c.scryptSync(code, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const hash = ["scrypt", "1", "16384", "8", "1", salt.toString("base64url"), key.toString("base64url")].join("$");
  console.log("Review code (store it, paste it into the review notes): " + code);
  console.log("Add to the api env, single-quoted because of the $ signs:");
  console.log("REVIEW_ACCOUNT_CODE_HASH=\x27" + hash + "\x27");
};
if (process.argv[1] === "stdin") {
  let d = "";
  process.stdin.on("data", (x) => { d += x; }).on("end", () => run(d.trim()));
} else {
  run(String(c.randomInt(0, 1000000)).padStart(6, "0"));
}
'

code=""
if [ "$mode" = "stdin" ]; then
  if [ -t 0 ]; then
    printf 'Review code (6 digits): ' >&2
    # `|| true`: read returns 1 at EOF without a trailing newline (set -e would exit silently);
    # the partial line is still in $code.
    stty -echo; IFS= read -r code || true; stty echo; printf '\n' >&2
  else
    IFS= read -r code || true
  fi
fi

if command -v node >/dev/null 2>&1; then
  printf '%s' "$code" | node -e "$js" "$mode"
else
  printf '%s' "$code" | docker run --rm -i node:22-alpine node -e "$js" "$mode"
fi
