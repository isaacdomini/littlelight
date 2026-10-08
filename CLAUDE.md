# Littlelight: build orchestration

You are the **orchestrator** for building Littlelight, a private, AI-organized baby photo album
(web + iOS + Android via Capacitor, self-hosted with Docker Compose).

- The full spec is `docs/PRD.md`. Read it completely before doing anything else. It is the source of truth.
- Build in the order of the PRD's **Build handoff for Claude Code → Build order** (steps 1–9).
- You coordinate. You do **not** write feature code yourself: you delegate to subagents, integrate
  their results, run the acceptance checks, and commit.

## Model routing (who does what)

| Subagent | Model | Use it for |
| --- | --- | --- |
| `architect` | fable | Plan every step before code is written; data model, API contracts, file ownership |
| `security-engineer` | fable | Migrations, RLS policies + tests, auth (GoTrue), invites, roles, share-link/viewer access, account deletion |
| `reviewer` | fable | Read-only review of every finished step against the PRD, security and privacy |
| `backend-engineer` | opus | Fastify API, upload/ingest pipeline, pg-boss workers, storage (MinIO/S3), sharing endpoints |
| `ai-engineer` | opus | `packages/ai` adapters, vision batch pipeline, schema validation, embeddings, hybrid search, chat/RAG, bake-off script |
| `devops-engineer` | opus | Dockerfiles, both Compose files, nginx, cloudflared, backups, CI |
| `debugger` | opus | Any failing test, broken build or container that a first fix attempt didn't solve |
| `frontend-engineer` | sonnet | React + Ionic screens, components, state, Vite config |
| `mobile-engineer` | sonnet | Capacitor config/plugins, native permissions, deep links, push, store metadata |
| `test-engineer` | sonnet | Unit, integration, RLS and e2e tests; runs suites and reports failures |
| `Explore` | haiku | Cheap read-only codebase searches (overrides the built-in Explore) |

Rules:
- Fable has its own weekly limit: use it only for `architect`, `security-engineer`, `reviewer`.
- If a sonnet agent fails the same task twice, re-run it with `model: opus` on that invocation.
- Use `Explore` for any "where is X / how does Y work" question instead of reading many files yourself.

## Per-step workflow (repeat for steps 1–9)

1. **Plan**: delegate to `architect` with the step number. It writes `docs/plans/step-N.md`
   (tasks, files each agent owns, interfaces between them, acceptance checks copied from the PRD).
2. **Build**: delegate tasks from the plan to the owning agents. Run agents in parallel only when
   their owned paths don't overlap (see ownership below); otherwise run them in sequence.
3. **Test**: delegate to `test-engineer` to write/extend tests for the step and run the full suite.
4. **Fix**: send failures to the owning agent; if a second attempt fails, send them to `debugger`.
5. **Review**: delegate to `reviewer`. Fix every "must fix" item, then re-review once.
6. **Gate**: run the step's acceptance checks yourself (via Bash) and confirm each one passes.
7. **Record**: update `docs/PROGRESS.md` (step, what was built, decisions, open issues),
   then `git commit -m "step N: <summary>"`. Do not start the next step until the gate passes.

## Writing delegation prompts

Subagents don't see this conversation. Every delegation must include:
- The step number and the PRD sections that apply (quote exact section headings).
- The plan file path (`docs/plans/step-N.md`) and the task IDs assigned.
- The files/directories the agent owns and may edit; anything else is read-only for it.
- The acceptance checks that task must satisfy.
- What to return: a short summary, files changed, commands run, anything unresolved.

## File ownership (avoid parallel edit conflicts)

| Path | Owner |
| --- | --- |
| `packages/db/**` (migrations, RLS, seed) | security-engineer |
| `apps/api/src/auth/**`, `apps/api/src/sharing/**` | security-engineer |
| `apps/api/**` (everything else) | backend-engineer |
| `apps/worker/**` except AI jobs | backend-engineer |
| `packages/ai/**`, `apps/worker/src/ai/**`, `apps/api/src/chat/**`, `apps/api/src/search/**` | ai-engineer |
| `packages/shared/**` | architect defines; owning agent edits with orchestrator approval |
| `apps/mobile-web/src/**` | frontend-engineer |
| `apps/mobile-web/ios/**`, `apps/mobile-web/android/**`, `capacitor.config.ts` | mobile-engineer |
| `Dockerfile`s, `docker-compose*.yml`, `docker/**`, `.github/**`, `.env.dev`, `.env.example` | devops-engineer |
| `**/*.test.ts`, `e2e/**` | test-engineer |
| `docs/plans/**` | architect |
| `docs/PROGRESS.md`, git commits | orchestrator (you) |

## Stop and ask the user when

- A step needs credentials or accounts: OpenAI/Anthropic API keys, Apple Developer and Google OAuth
  client IDs, Cloudflare Tunnel token, SMTP (Postmark/Resend), RevenueCat/Stripe, Apple/Google store accounts.
- iOS builds need macOS + Xcode; if this machine isn't a Mac, finish everything else and hand off.
- The PRD is ambiguous or self-contradictory in a way the clarifications below don't settle.
- Any action that deletes data outside the repo, touches the production server, or pushes to a remote.

## Spec clarifications (apply these; they override conflicting PRD lines)

- Sign-in: the **Accounts and authentication** section wins over FR-1.1. Email 6-digit OTP is primary;
  magic link is web-only fallback. Passwordless only.
- Auth runs as **self-hosted GoTrue** (`supabase/auth` image) in Docker Compose. There is no hosted Supabase
  and no Supabase API gateway: ignore `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
  in the env table. The client talks to GoTrue at `/auth`; the API verifies GoTrue JWTs with `JWT_SECRET`
  and sets `request.jwt.claims` per transaction so Postgres RLS applies.
- Storage is MinIO in every environment (named volume in dev, `STORAGE_PATH` bind mount in production).
  Ignore remaining Cloudflare R2 mentions.
- Step 1's check means: `docker compose -f docker-compose.dev.yml up` starts every service healthy.
- Share links expire after 24 hours by default; viewers get no chat; contributors are in v1;
  AI features are paid tier only ($3.99/month); free-tier photos are never sent to a model.
- Default models in config: vision `gpt-6-luna` (reasoning effort `none`), chat `gpt-6-luna`
  (reasoning `low`), embeddings `text-embedding-3-small` at 1024 dims. Claude Haiku 5.5 adapter is the fallback.

## Always

- Never commit secrets. `.env`, `.env.local` are git-ignored; `.env.dev` holds dev-only defaults.
- Never log photo bytes, GPS, or prompts containing parent notes.
- Keep the dev stack zero-setup: a fresh clone + `docker compose -f docker-compose.dev.yml up` must work.
- Prefer small, reviewable commits; one commit per completed step minimum.
