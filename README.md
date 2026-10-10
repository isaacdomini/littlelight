# Tinyglow

Private, AI-organized baby photo album. Spec: `docs/PRD.md`. Build plans: `docs/plans/`.

## Layout

pnpm monorepo, TypeScript everywhere:

| Package | Path |
| --- | --- |
| `@tinyglow/api` | `apps/api` (Fastify) |
| `@tinyglow/worker` | `apps/worker` (pg-boss) |
| `@tinyglow/mobile-web` | `apps/mobile-web` (React + Vite + Ionic) |
| `@tinyglow/db` | `packages/db` (migrations, bootstrap, seed) |
| `@tinyglow/shared` | `packages/shared` (zod schemas, constants) |
| `@tinyglow/ai` | `packages/ai` (model adapters) |

`packages/shared` and `packages/ai` export TypeScript source directly; no build step.

## Run the dev stack (zero setup)

Only Docker is required:

```sh
docker compose -f docker-compose.dev.yml up        # or: pnpm dev
docker compose -f docker-compose.dev.yml down      # or: pnpm dev:down
pnpm dev:reset                                     # wipe dev volumes and start fresh
```

Optional personal secrets (e.g. `OPENAI_API_KEY`) go in a git-ignored `.env.local`.

## Host tooling (lint, typecheck, unit tests)

- Node 22 (`.nvmrc`: 22.23.3). Newer Node works with an engines warning.
- pnpm 12.10.1 (pinned in `packageManager`): `npm i -g pnpm@12.10.1` or `corepack enable`.

```sh
pnpm install --frozen-lockfile
pnpm lint          # Biome (format + lint check); `pnpm format` writes fixes
pnpm typecheck     # tsc --noEmit in every package
pnpm test          # Vitest unit tests (no DB or network)
DATABASE_URL=postgres://postgres:dev@localhost:5432/tinyglow pnpm test:integration
```
