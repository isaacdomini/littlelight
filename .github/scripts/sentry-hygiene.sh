#!/usr/bin/env bash
# Sentry hygiene (docs/plans/review-fixes.md 2.14 "Sentry hygiene"; task R.13), run by the CI
# `check` job and runnable locally from the repo root:
#
#   bash .github/scripts/sentry-hygiene.sh [--root <dir>]
#
# No @sentry/capacitor, replay, tracing, profiling or @opentelemetry package as a direct
# dependency in any package.json (the lockfile's transitive entries are expected), and every
# Sentry.init under apps/*/src and packages/*/src is errors-only: `dataCollection` with every
# category off, `defaultIntegrations: false`, `tracesSampleRate: 0`, `beforeBreadcrumb` => null,
# `beforeSend` = the shared `scrubTelemetryEvent`, web init behind `isNative()`. The checks live in
# sentry-hygiene.mjs (Node built-ins only, so it also runs before `pnpm install`).
set -euo pipefail
exec node "$(dirname "$0")/sentry-hygiene.mjs" "$@"
