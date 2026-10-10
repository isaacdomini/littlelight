# syntax=docker/dockerfile:1
# Tinyglow database tools image (Compose one-shots `db-init` and `migrate`). Build context:
# repo root (docs/plans/step-1.md 2.13, step-2.md 2.13).
#   db-init : pnpm db:bootstrap   roles (GoTrue's supabase_auth_admin, app roles) + auth schema
#   migrate : pnpm db:migrate     (re-runs the idempotent bootstrap) + SQL migrations; dev also seeds
# Same image in dev and prod.
#
# `pnpm deploy` makes a standalone copy with only @tinyglow/db's own dependencies (pg,
# node-pg-migrate, tsx). A filtered `pnpm install` would also pull in the workspace root's
# devDependencies (biome, vitest -> vite, ...), roughly 4x the size.
ARG NODE_IMAGE=node:22.23.3-alpine
ARG PNPM_VERSION=12.10.1

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deploy
ARG PNPM_VERSION
ENV CI=true \
    npm_config_update_notifier=false \
    PNPM_STORE_DIR=/pnpm/store
RUN npm i -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo
# Every workspace manifest, so the shared lockfile matches all importers.
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mobile-web/package.json apps/mobile-web/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY tsconfig.base.json ./
COPY packages/db packages/db
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @tinyglow/db deploy --store-dir /pnpm/store /app \
 && rm -f /app/Dockerfile \
 && chmod -R a+rX,go-w /app /repo/tsconfig.base.json

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG PNPM_VERSION
# pnpm_config_verify_deps_before_run=false: without it every `pnpm db:*` first runs an install
# that, under NODE_ENV=production, tries to prune devDependencies (tsx) from the deployed
# node_modules. It only fails today because the files are root-owned/read-only; never let it.
ENV CI=true \
    npm_config_update_notifier=false \
    pnpm_config_verify_deps_before_run=false \
    NODE_ENV=production
RUN apk add --no-cache tini && npm i -g pnpm@${PNPM_VERSION} && npm cache clean --force
# Root-owned and read-only for the runtime user. Same paths as the repo, so
# packages/db/tsconfig.json's `extends: ../../tsconfig.base.json` resolves.
# (WORKDIR first: COPY --chmod would also apply its mode to implicitly created parent dirs.)
WORKDIR /repo/packages/db
COPY --from=deploy /repo/tsconfig.base.json /repo/tsconfig.base.json
COPY --from=deploy /app /repo/packages/db
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "db:migrate"]
