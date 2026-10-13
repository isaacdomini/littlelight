#!/bin/sh
# Live updates (docs/plans/step-14.md D2, D6, 2.9): makes the ECDSA P-256 key pair that signs the
# OTA web-bundle manifest. The api holds the private half (APP_UPDATE_SIGNING_KEY_BASE64, base64
# PKCS#8 DER, api only); the apps hold the public half (base64 SPKI DER) compiled in
# (packages/shared/src/app-update.ts APP_UPDATE_PUBLIC_KEYS, LLUpdateKeys.swift, UpdateKeys.java).
#
#   sh docker/tools/app-update-keygen.sh            # new pair: prints the .env line + public SPKI
#   sh docker/tools/app-update-keygen.sh --public   # public SPKI of a private key you paste
#                                                   # (stdin, not echoed; the base64 value or the
#                                                   # whole APP_UPDATE_SIGNING_KEY_BASE64=... line)
#
# Output of a new pair (two lines):
#   APP_UPDATE_SIGNING_KEY_BASE64=<base64 PKCS#8 DER>     -> the server's .env (api only)
#   # public SPKI: <base64 SPKI DER>                     -> compare with packages/shared (keyId)
# The private key is printed once and never written to disk by this script; redirect stdout to
# a mode-600 file yourself if you need to carry it (umask 077; sh ... > key.env). A new
# production key only works after a store build that trusts its public half is installed
# (rotation: docs/PRODUCTION.md, Part L).
#
# Uses openssl (macOS LibreSSL or OpenSSL 1.1+/3.x); falls back to a local `node`, then to the
# node:22-alpine image.
set -eu

mode="new"
case "${1:-}" in
  "") ;;
  --public) mode="public" ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "usage: sh $0 [--public]" >&2; exit 2 ;;
esac

# One-line base64 on both BSD (no wrap) and GNU (wraps at 76) base64.
b64() { base64 | tr -d '\n\r '; }

# Node fallback (same output format). Runs with no argv secrets: the private key, if any, is on
# stdin.
js='
const c = require("node:crypto");
const mode = process.argv[1];
const out = (k) => {
  const pub = c.createPublicKey(k).export({ type: "spki", format: "der" }).toString("base64");
  if (mode === "public") { console.log("# public SPKI: " + pub); return; }
  const priv = k.export({ type: "pkcs8", format: "der" }).toString("base64");
  console.log("APP_UPDATE_SIGNING_KEY_BASE64=" + priv);
  console.log("# public SPKI: " + pub);
};
if (mode === "public") {
  let d = "";
  process.stdin.on("data", (x) => { d += x; }).on("end", () => {
    const v = d.trim().replace(/^APP_UPDATE_SIGNING_KEY_BASE64=/, "").replace(/^["\x27]|["\x27]$/g, "");
    const k = c.createPrivateKey({ key: Buffer.from(v, "base64"), format: "der", type: "pkcs8" });
    if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails.namedCurve !== "prime256v1") {
      console.error("not an EC P-256 PKCS#8 key"); process.exit(1);
    }
    out(k);
  });
} else {
  out(c.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
}
'

run_node() {
  if command -v node >/dev/null 2>&1; then
    node -e "$js" "$mode"
  else
    docker run --rm -i node:22-alpine node -e "$js" "$mode"
  fi
}

# A P-256 SPKI DER is 91 bytes = 124 base64 chars with this fixed prefix (id-ecPublicKey +
# prime256v1 + uncompressed point).
SPKI_PREFIX="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"

if [ "$mode" = "public" ]; then
  key=""
  if [ -t 0 ]; then
    printf 'APP_UPDATE_SIGNING_KEY_BASE64 value: ' >&2
    stty -echo; IFS= read -r key || true; stty echo; printf '\n' >&2
  else
    IFS= read -r key || true
  fi
  printf '%s' "$key" | run_node
  exit 0
fi

if command -v openssl >/dev/null 2>&1; then
  # SEC1 PEM held in a shell variable only (never a file), then converted twice.
  pem="$(openssl ecparam -name prime256v1 -genkey -noout)"
  priv="$(printf '%s\n' "$pem" | openssl pkcs8 -topk8 -nocrypt -outform DER | b64)"
  pub="$(printf '%s\n' "$pem" | openssl ec -pubout -outform DER 2>/dev/null | b64)"
  pem=""
  case "$pub" in
    "$SPKI_PREFIX"*) ;;
    *) echo "openssl produced an unexpected public key; is this P-256?" >&2; exit 1 ;;
  esac
  # PKCS#8 of an EC key starts with the id-ecPublicKey AlgorithmIdentifier.
  case "$priv" in
    MIG*AgEAMBMGByqGSM49AgEGCCqGSM49AwEH*) ;;
    *) echo "openssl produced an unexpected private key encoding" >&2; exit 1 ;;
  esac
  printf 'APP_UPDATE_SIGNING_KEY_BASE64=%s\n' "$priv"
  printf '# public SPKI: %s\n' "$pub"
else
  run_node </dev/null
fi
