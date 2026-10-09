# @littlelight/ai

The only package that talks to model providers. API and worker code call the factories and
interfaces exported here and never import a provider SDK directly (PRD "Build handoff for Claude
Code" -> "Conventions"). This keeps the vision, chat and embedding models a config choice, not a
code change.

Status: **step 6.** Vision adapters are real: OpenAI Batch API (`gpt-6-luna`, primary),
Anthropic Message Batches (`claude-haiku-5-5`, fallback) and a deterministic `fake` provider,
plus the embedder (no caller until step 7), the pinned price table, prompt v1 and output
validation. No SDKs: plain `fetch` (docs/plans/step-6.md D2). Chat (`createChatModel`) still
throws `AiNotImplementedError` until step 7.

## Exports

| Export | Purpose |
| --- | --- |
| `VisionDescriber`, `ChatModel`, `Embedder` (+ request/result types) | Provider-neutral interfaces (`src/types.ts`) |
| `createVisionDescriber(env, {log?, fetch?})` | `openai` / `anthropic` / `fake` by `VISION_PROVIDER`. `AiNotConfiguredError` without the key (or `fake` in production), `AiConfigError` for invalid config or an unpriced `VISION_MODEL` |
| `createEmbedder(env, deps?)` | OpenAI `/v1/embeddings` (`EMBED_DIMS`); deterministic fake vectors when `VISION_PROVIDER=fake` |
| `createChatModel(env)` | Step 7 |
| `createOpenAiVisionDescriber`, `createAnthropicVisionDescriber`, `createFakeVisionDescriber`, `createOpenAiEmbedder`, `createFakeEmbedder` | Direct construction (tests, bake-off) |
| `assembleVisionRequest`, `checkVisionRequest`, `checkVisionBatch`, `sanitizeVisionContext`, `openAiResponsesBody`, `anthropicMessageParams`, `estimateVisionRequestBytes` | Request assembly and runtime guards (`src/request.ts`) |
| `validateDescription(raw)`, `mergeOverrides(desc, overrides)` | Output validation against `aiDescriptionV1Schema` (issues are paths + codes, never values) |
| `PRICES`, `PRICE_TABLE_VERSION`, `costUsd(model, tier, usage)`, `assertPriced` | Pinned price table (`src/pricing.ts`) |
| `DESCRIBE_SYSTEM_PROMPT_V1`, `DESCRIBE_PROMPT_V1_SHA256`, `buildUserText(context)` | Prompt v1 (`src/prompts/describe-v1.ts`); the sha is pinned by a test |
| `isTerminalBatchState`, `sumUsage`, `readImageInfo`, `assertAnalysisImage`, `fakeDescription` | Helpers |
| `aiEnvSchema`, `parseAiEnv`, `isAiConfigured`, `getAiStatus` | Env (`src/env.ts`); status strings name env vars only |
| `AiNotConfiguredError`, `AiNotImplementedError`, `AiConfigError`, `AiRequestError`, `AiProviderError` | Errors: field names, codes and HTTP statuses only, never bodies |

Not exported from the entry (tests import by path): `src/testing/*` (in-process mock servers
for both providers) and `src/bakeoff/run.ts`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `VISION_PROVIDER` | `openai` | `openai` (GPT-6 Luna, primary), `anthropic` (Claude Haiku 5.5, fallback) or `fake` (no key, no network; refused when `NODE_ENV=production` unless `AI_ALLOW_FAKE_IN_PRODUCTION=true`) |
| `VISION_MODEL` / `VISION_REASONING_EFFORT` | `gpt-6-luna` / `none` | Describe stage, Batch API. Must be in the price table. Use `claude-haiku-5-5` with `anthropic` |
| `CHAT_MODEL` / `CHAT_REASONING_EFFORT` | `gpt-6-luna` / `low` | Interactive chat, real-time (step 7) |
| `EMBED_MODEL` / `EMBED_DIMS` | `text-embedding-3-small` / `1024` | Always OpenAI. `EMBED_DIMS` must match `photo_search.embedding vector(1024)` |
| `OPENAI_API_KEY` | unset | Required for `openai` and for embeddings. Put it in `.env.local` (worker only) |
| `ANTHROPIC_API_KEY` | unset | Required only when `VISION_PROVIDER=anthropic` (and for the bake-off) |
| `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | real APIs | Mock servers only; whatever is set here receives photos |
| `AI_MAX_OUTPUT_TOKENS`, `AI_IMAGE_DETAIL`, `AI_BATCH_MAX_BYTES` | 1200, `auto`, 150 MB | From `aiPipelineEnvSchema` (`@littlelight/shared`) |
| `FAKE_VISION_DIR` | unset | Fake only: `<batchId>.jsonl` (request lines minus image bytes and text: ids, plan, image size, context field lengths) and `<batchId>.state.json` (ids, poll count) so a batch survives across processes |
| `FAKE_VISION_POLLS` | `1` | Fake only: polls answered `in_progress` before `completed` |

Empty strings count as unset. Reasoning efforts are `none | low | medium | high`; on Anthropic
`none` means thinking disabled with `output_config.effort: "low"`.

## Request shapes (docs/plans/step-6.md 2.2)

- **OpenAI**: JSONL lines `{custom_id: photoId, method: "POST", url: "/v1/responses", body}` with
  `body = {model, instructions, text: {format: {type: "json_schema", name: "littlelight_photo_v1",
  schema, strict: true}}, reasoning: {effort}, input: [{role: "user", content: [input_image
  (data:image/jpeg;base64,…), input_text]}], max_output_tokens, prompt_cache_key:
  "littlelight-describe-v1", store: false}`; uploaded with `purpose=batch`; batch created with
  `endpoint: "/v1/responses"`, `completion_window: "24h"`. Input, output and error files are
  deleted by `deleteBatchArtifacts` (404 = already gone). If batch creation fails after the
  upload, the input file is deleted immediately.
- **Anthropic**: `POST /v1/messages/batches {requests: [{custom_id, params}]}` with `params =
  {model, max_tokens, system: [{text, cache_control: {type: "ephemeral", ttl: "1h"}}],
  output_config: {format: {type: "json_schema", schema}, effort}, thinking, messages: [{role:
  "user", content: [image (base64), text]}]}`; `anthropic-version: 2023-06-01`, no beta header.
  `deleteBatchArtifacts` deletes the batch after it has ended.
- **Retries**: GET/DELETE and real-time calls retry network errors, 408/409/429/5xx (≤ 3, jittered
  backoff, `retry-after` honoured). File upload and batch create retry 429 only, so a retry can
  never leave a duplicate copy of photos at the provider.

## Costs

`PRICE_TABLE_VERSION = "2026-10-08"`. Batch tier for `gpt-6-luna`: $0.05 in / $0.005 cached /
$0.0625 cache write / $0.25 out per 1M tokens; 1,400 in (700 cached) / 400 out = $0.0001385 per
photo. `claude-haiku-5-5` batch cached-read and cache-write prices are assumptions (plan R6).
Unknown models are a config error, never $0.

## Bake-off

```sh
set -a; . ./.env.local; set +a    # OPENAI_API_KEY, ANTHROPIC_API_KEY
pnpm bakeoff -- --photos <dir of ≤768 px JPEG/WebP> --providers openai,anthropic --mode batch \
  [--labels labels.json] [--limit 200] [--out report.md] [--poll-seconds 30] [--timeout-min 360]
pnpm bakeoff -- --photos e2e/fixtures/bakeoff-sample --providers fake   # offline
```

Relative paths resolve against the invocation directory, then the workspace root. Files with a
long edge over 768 px (or over 400 KB) are refused: the bake-off never resizes.
`labels.json`: `{ "<file>": { "sensitive": ["bath"], "milestone": "first steps", "context":
{ "people": ["Dad"] } } }`. The report is a table of metric × provider: schema validity,
refusals, sensitive-content recall/precision, milestone hit rate, mean input/cached/output/
image/reasoning tokens, total cost, cost per photo and per 1,000, wall time. Batch artifacts are
deleted after each provider run. No Gemini adapter (plan D10).

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
8. **Record cost.** Every result carries `ModelUsage` (input, cached input, cache write, output,
   reasoning and image tokens, plus `costUsd` from the pinned price table) so `ai_batches` and
   the bake-off can report cost per photo.
9. **Tool and photo text is data.** Chat tool outputs and `text_in_image` are never instructions
   (prompt-injection guardrail).
