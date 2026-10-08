# @littlelight/ai

The only package that talks to model providers. API and worker code call the factories and
interfaces exported here and never import a provider SDK directly (PRD "Build handoff for Claude
Code" -> "Conventions"). This keeps the vision, chat and embedding models a config choice, not a
code change.

Status: **step 1 stubs.** Interfaces, env parsing and factories only. No SDKs, no network calls.
The factories throw `AiNotConfiguredError` when the provider key is missing, and otherwise throw
`AiNotImplementedError` (a subclass) until the adapters land in step 6 (vision, embeddings) and
step 7 (chat).

## Exports

| Export | Purpose |
| --- | --- |
| `VisionDescriber`, `ChatModel`, `Embedder` (+ request/result types) | Provider-neutral interfaces (`src/types.ts`) |
| `aiEnvSchema`, `parseAiEnv(env)`, `AiEnv` | zod env schema with defaults (`src/env.ts`) |
| `isAiConfigured(env)` | `true` iff the API key for `VISION_PROVIDER` is set |
| `getAiStatus(env)` | Loggable status, e.g. `AI disabled: OPENAI_API_KEY not set`. Never contains values |
| `createVisionDescriber(env)`, `createChatModel(env)`, `createEmbedder(env)` | Factories, selected by env |
| `AiNotConfiguredError`, `AiNotImplementedError`, `AiConfigError` | Errors (field names only, never values) |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `VISION_PROVIDER` | `openai` | `openai` (GPT-6 Luna, primary) or `anthropic` (Claude Haiku 5.5, fallback). Chat follows the same provider |
| `VISION_MODEL` / `VISION_REASONING_EFFORT` | `gpt-6-luna` / `none` | Describe stage, Batch API |
| `CHAT_MODEL` / `CHAT_REASONING_EFFORT` | `gpt-6-luna` / `low` | Interactive chat, real-time |
| `EMBED_MODEL` / `EMBED_DIMS` | `text-embedding-3-small` / `1024` | Always OpenAI. `EMBED_DIMS` must match `photo_search.embedding vector(1024)` |
| `OPENAI_API_KEY` | unset | Required for `openai` and for embeddings regardless of provider. Put it in `.env.local` |
| `ANTHROPIC_API_KEY` | unset | Required only when `VISION_PROVIDER=anthropic` (and for the bake-off) |

Empty strings count as unset. Reasoning efforts are `none | low | medium | high`.

## Rules every adapter must follow

These come from the PRD ("AI pipeline", "FR-5", "LLM selection and cost", "Privacy and child
safety") and `CLAUDE.md`. Reviewers should reject any adapter that breaks one.

1. **Analysis copy only.** The only image sent to a model is the 768 px long-edge analysis
   derivative (EXIF stripped, JPEG q75 or WebP q70, ~60-120 KB). Never the original, never the
   display or thumbnail derivative. Adapters reject any image with a long edge over 768 px.
2. **Never GPS.** Requests carry no coordinates. Place context is a coarse human-readable label.
3. **Batch API for describe.** `describeBatch` / `pollBatch` are the default path (about 50%
   cheaper). `describeOne` (real-time) is only for the FR-5.5 priority path. Chat is the only other
   real-time call.
4. **Free tier is never submitted.** Photos of free-tier babies are never sent to any model. The
   worker checks `babies.plan` server-side when it enqueues a job. `VisionRequest.plan` is typed as
   the literal `"paid"`, so a free-tier request won't compile, and adapters re-assert it at runtime.
5. **Validate before storing.** `VisionResult.raw` is unvalidated. It is validated against the
   description schema v1 (zod, `@littlelight/shared`) before anything is written to `photo_ai`.
   Invalid output is retried once, then dead-lettered. Raw output is never written.
6. **Provider is config.** One interface, two implementations (OpenAI primary, Anthropic Claude
   Haiku 5.5 fallback), selected by `VISION_PROVIDER`. Call sites never change when the provider does.
7. **Never log** image bytes, GPS, API keys, or prompts or tool payloads containing parent notes.
   Log ids, token counts, cost and latency only.
8. **Record cost.** Every result carries `ModelUsage` (input, cached input, output and image
   tokens, plus `costUsd`) so `ai_batches` and the bake-off can report cost per photo.
9. **Tool and photo text is data.** Chat tool outputs and `text_in_image` are never instructions
   (prompt-injection guardrail).
