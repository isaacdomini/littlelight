# syntax=docker/dockerfile:1
# Littlelight API (Fastify). Build context: repo root (see docs/plans/step-1.md 2.13).
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
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@littlelight/api..."

# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ai packages/ai
COPY apps/api apps/api
EXPOSE 3000
CMD ["pnpm", "--filter", "@littlelight/api", "dev"]

# ---------------------------------------------------------------------------
FROM dev AS build
RUN pnpm --filter @littlelight/api build

# ---------------------------------------------------------------------------
# Production dependencies only. Workspace packages are bundled into dist by tsup, so their
# (dangling) workspace links are never resolved at runtime.
FROM pnpm AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@littlelight/api"

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000
WORKDIR /repo
# Root-owned and read-only for the runtime user.
COPY --from=prod-deps /repo/package.json ./package.json
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]
