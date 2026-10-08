# syntax=docker/dockerfile:1
# Littlelight web app (React + Vite + Ionic). Build context: repo root (docs/plans/step-1.md 2.13).
#   dev  : Vite dev server on :8080; docker-compose.dev.yml bind-mounts the src dirs over it
#   prod : nginx serving the Vite build on :80, proxying /api/ and /auth/ (docker/nginx/default.conf)
ARG NODE_IMAGE=node:22.23.3-alpine
ARG NGINX_IMAGE=nginx:1.28-alpine
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
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@littlelight/mobile-web..."

# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mobile-web apps/mobile-web
EXPOSE 8080
CMD ["pnpm", "--filter", "@littlelight/mobile-web", "dev", "--host", "0.0.0.0", "--port", "8080"]

# ---------------------------------------------------------------------------
FROM dev AS build
ENV NODE_ENV=production
RUN pnpm --filter @littlelight/mobile-web build

# ---------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS prod
RUN rm -f /etc/nginx/conf.d/*.conf
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/mobile-web/dist /usr/share/nginx/html
# GoTrue fetches its email templates from http://web/email-templates/* (docs/plans/step-1.md 2.6).
COPY docker/gotrue/templates /usr/share/nginx/html/email-templates
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-qO-", "http://127.0.0.1/healthz"]
