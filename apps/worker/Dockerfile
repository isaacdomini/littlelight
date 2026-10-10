# syntax=docker/dockerfile:1
# Littlelight worker (pg-boss). Build context: repo root (see docs/plans/step-1.md 2.13).
#   dev  : deps installed, source copied; docker-compose.dev.yml bind-mounts the src dirs over it
#   prod : slim node:22 alpine, non-root, tsup bundle + production node_modules only
ARG NODE_IMAGE=node:22.23.3-alpine
ARG PNPM_VERSION=12.10.1

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS pnpm
ARG PNPM_VERSION
ENV CI=true \
    npm_config_update_notifier=false \
    PNPM_STORE_DIR=/pnpm/store
RUN npm i -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo
# Every workspace manifest, so the shared lockfile matches all importers under --frozen-lockfile.
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mobile-web/package.json apps/mobile-web/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

# ---------------------------------------------------------------------------
FROM pnpm AS base
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@littlelight/worker..."

# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ai packages/ai
COPY apps/worker apps/worker
CMD ["pnpm", "--filter", "@littlelight/worker", "dev"]

# ---------------------------------------------------------------------------
FROM dev AS build
RUN pnpm --filter @littlelight/worker build

# ---------------------------------------------------------------------------
# Production dependencies only. Workspace packages are bundled into dist by tsup.
FROM pnpm AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@littlelight/worker" \
 && find node_modules -path '*/@sentry*/*' -name '*.map' -type f -delete
# ^ Sentry ships source maps for every build flavour (~35 MB); production stack traces point at
# its compiled JS instead (our own dist keeps its maps for --enable-source-maps). Deleted in
# this stage, before the COPY into prod, so the files never reach an image layer.

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /repo
# Root-owned and read-only for the runtime user.
COPY --from=prod-deps /repo/package.json ./package.json
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
USER node
# Heartbeat row must be fresh (and storage reachable) within HEARTBEAT_STALE_MS.
HEALTHCHECK --interval=10s --timeout=10s --start-period=60s --retries=2 \
  CMD ["node", "apps/worker/dist/healthcheck.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/worker/dist/main.js"]
