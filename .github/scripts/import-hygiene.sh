#!/usr/bin/env bash
# Photo-import hygiene (docs/plans/step-10.md 2.10 "CI (10.14)", 4.1; task 10.14), run by the CI
# `check` job after `pnpm install` and runnable locally from the repo root:
#
#   bash .github/scripts/import-hygiene.sh
#
#   1. Static checks (.github/scripts/import-hygiene.mjs, header there): nothing in the import
#      code logs a baseUrl, pickerUri, token, code, secret or raw error, and the iOS
#      TinyglowPhotoSync.swift prints nothing; the worker never names google_accounts (token
#      only via import_google_refresh_token()) and never inserts into photos (booking only via
#      import_book_photo()), and no migration/bootstrap grant would let it; the URL guard
#      (parseAllowedMediaUrl / resolveMediaRedirect, null-checked, redirect "manual") precedes
#      every media request; the fake provider is refused in production (schema, api/worker
#      configs, fake server, prod Compose); GOOGLE_IMPORT_CLIENT_SECRET never in the client app
#      or the web image.
#   2. Runtime proof that the fake is refused in production (needs `pnpm install`, uses tsx):
#      a. googleImportEnvSchema rejects GOOGLE_IMPORT_PROVIDER=fake with NODE_ENV=production
#         (issue on GOOGLE_IMPORT_PROVIDER) and accepts it in development; `live` without the
#         OAuth client is rejected too;
#      b. startFakeGoogleServer({ nodeEnv: "production" }) rejects, while the same call with
#         nodeEnv "test" starts and answers /healthz (control: the refusal is about production);
#      c. the CLI (`google-fake`) with NODE_ENV=production exits 1 with its refusal message
#         within 60 s and never listens (a watchdog kills it otherwise, and the step fails).
#   3. Step-10 scope vs IMPORT_DRIFT_BASE (default b3f2b56, the review-fix commit step 10 starts
#      from; import-hygiene.mjs --drift): no change under the AI paths, and @capacitor/browser is
#      the only new dependency. Needs the base commit in the clone (CI: fetch-depth 0).
#      IMPORT_DRIFT_BASE=skip skips it (local runs on a shallow clone only; CI never sets it).
#
# Each part reports on its own; the script exits 1 if any failed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
BASE="${IMPORT_DRIFT_BASE:-b3f2b56}"
fail=0

echo "-- static"
node "$HERE/import-hygiene.mjs" || fail=1

echo "-- runtime: fake refused in production"
if [ ! -x node_modules/.bin/tsx ]; then
  echo "::error::node_modules/.bin/tsx is missing (run pnpm install first)"
  fail=1
else
  TSX="$ROOT/node_modules/.bin/tsx"

  # 2a + 2b in one tsx process (dynamic imports of the real modules, no build step). The `${…}`
  # below are JavaScript template literals, not shell expansions.
  # shellcheck disable=SC2016
  if ROOT="$ROOT" "$TSX" -e '
(async () => {
  const root = process.env.ROOT;
  const bad = [];
  const { googleImportEnvSchema } = await import(`${root}/packages/shared/src/env.ts`);
  const prodFake = googleImportEnvSchema.safeParse({ GOOGLE_IMPORT_PROVIDER: "fake", NODE_ENV: "production" });
  if (prodFake.success) bad.push("schema accepts fake in production");
  else if (!prodFake.error.issues.some((i) => i.path.join(".") === "GOOGLE_IMPORT_PROVIDER"))
    bad.push("schema rejects fake in production, but not on GOOGLE_IMPORT_PROVIDER");
  if (!googleImportEnvSchema.safeParse({ GOOGLE_IMPORT_PROVIDER: "fake", NODE_ENV: "development" }).success)
    bad.push("control: schema rejects fake in development");
  if (!googleImportEnvSchema.safeParse({ GOOGLE_IMPORT_PROVIDER: "none", NODE_ENV: "production" }).success)
    bad.push("control: schema rejects none in production");
  if (googleImportEnvSchema.safeParse({ GOOGLE_IMPORT_PROVIDER: "live", NODE_ENV: "production" }).success)
    bad.push("schema accepts live without the OAuth client");

  const { startFakeGoogleServer } = await import(`${root}/apps/worker/src/import/google/fake-server.ts`);
  try {
    const s = await startFakeGoogleServer({ port: 0, host: "127.0.0.1", nodeEnv: "production" });
    await s.close();
    bad.push("startFakeGoogleServer starts with nodeEnv production");
  } catch (e) {
    if (!/production/.test(String(e?.message))) bad.push("startFakeGoogleServer failed, but not with the production refusal");
  }
  try {
    const s = await startFakeGoogleServer({ port: 0, host: "127.0.0.1", nodeEnv: "test" });
    const r = await fetch(`${s.url}/healthz`);
    if (r.status !== 200) bad.push(`control: /healthz answered ${r.status}`);
    await s.close();
  } catch (e) {
    bad.push(`control: startFakeGoogleServer with nodeEnv test failed (${String(e?.message).slice(0, 120)})`);
  }
  for (const b of bad) console.error(`  ${b}`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(`  probe crashed: ${String(e?.message).slice(0, 200)}`); process.exit(1); });
'; then
    echo "ok: googleImportEnvSchema and startFakeGoogleServer refuse the fake in production (controls start)"
  else
    echo "::error::the fake Google provider is not refused in production (schema / library; above)"
    fail=1
  fi

  # 2c. The CLI. Port 1 below the dynamic range; nothing must bind it (refusal comes first).
  err="$(mktemp)"
  (cd apps/worker && NODE_ENV=production GOOGLE_FAKE_PORT=48399 GOOGLE_FAKE_HOST=127.0.0.1 \
    exec "$TSX" src/import/google/fake-server.ts) >/dev/null 2>"$err" &
  pid=$!
  rc=""
  for _ in $(seq 1 120); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      rc=$?
      break
    fi
    sleep 0.5
  done
  if [ -z "$rc" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    echo "::error::google-fake CLI with NODE_ENV=production was still running after 60 s (not refused)"
    fail=1
  elif [ "$rc" -eq 1 ] && grep -q 'refusing to start with NODE_ENV=production' "$err"; then
    echo "ok: the google-fake CLI exits 1 with NODE_ENV=production"
  else
    sed 's/^/  /' "$err" | head -n 5
    echo "::error::google-fake CLI with NODE_ENV=production exited $rc without its refusal message"
    fail=1
  fi
  rm -f "$err"
fi

echo "-- drift vs $BASE"
if [ "$BASE" = "skip" ]; then
  echo "::warning::IMPORT_DRIFT_BASE=skip: AI-path and dependency drift not checked"
else
  node "$HERE/import-hygiene.mjs" --drift "$BASE" || fail=1
fi

exit "$fail"
