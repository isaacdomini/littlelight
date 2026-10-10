# syntax=docker/dockerfile:1
# Tinyglow web app (React + Vite + Ionic). Build context: repo root (docs/plans/step-1.md 2.13).
#   dev  : Vite dev server on :8080; docker-compose.dev.yml bind-mounts the src dirs over it
#   prod : nginx serving the Vite build on :80, proxying /api/ and /auth/ (docker/nginx/default.conf,
#          plus the CSP snippet rendered from docker/nginx/templates/csp.conf.template at start)
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
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@tinyglow/mobile-web..."

# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mobile-web apps/mobile-web
EXPOSE 8080
CMD ["pnpm", "--filter", "@tinyglow/mobile-web", "dev", "--host", "0.0.0.0", "--port", "8080"]

# ---------------------------------------------------------------------------
FROM dev AS build
ENV NODE_ENV=production
# Sentry DSN for the web origin only (docs/plans/review-fixes.md 2.6, D8), baked into the bundle
# at build time. Empty (default) => no Sentry chunk is ever loaded. docker-compose.yml passes
# SENTRY_WEB_DSN here; the native builds (Capacitor) never set it. Vite reads VITE_* from the
# process environment, which a build ARG is during RUN.
ARG VITE_SENTRY_DSN=""
RUN pnpm --filter @tinyglow/mobile-web build

# ---------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS prod
# CSP snippet (docs/plans/review-fixes.md 2.11): the image's entrypoint renders
# /etc/nginx/templates/csp.conf.template into /etc/nginx/snippets/csp.conf on every start,
# substituting only the variables matched by NGINX_ENVSUBST_FILTER (so no nginx $variable in it
# can be mangled). The defaults below keep a plain `docker run` working (report-only, no S3
# origin); docker-compose.yml overrides them. The renderer needs a writable snippets dir: it is
# created here, and the container root filesystem stays writable (no read_only on `web`).
ENV WEB_CSP_HEADER=Content-Security-Policy-Report-Only \
    WEB_CSP_CONNECT_EXTRA="" \
    S3_PUBLIC_ENDPOINT="" \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets \
    NGINX_ENVSUBST_FILTER="^(WEB_CSP_HEADER|WEB_CSP_CONNECT_EXTRA|S3_PUBLIC_ENDPOINT)$"
RUN rm -f /etc/nginx/conf.d/*.conf && mkdir -p /etc/nginx/snippets /etc/nginx/templates
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/templates/csp.conf.template /etc/nginx/templates/csp.conf.template
COPY --from=build /repo/apps/mobile-web/dist /usr/share/nginx/html
# GoTrue fetches its email templates from http://web/email-templates/* (docs/plans/step-1.md 2.6).
COPY docker/gotrue/templates /usr/share/nginx/html/email-templates
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-qO-", "http://127.0.0.1/healthz"]
