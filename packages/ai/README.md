# @tinyglow/ai

The only package that talks to model providers. API and worker code call the factories and
interfaces exported here and never import a provider SDK directly (PRD "Build handoff for Claude
Code" -> "Conventions"). This keeps the vision, chat and embedding models a config choice, not a
code change.

Status: **step 7.** Vision adapters are real: OpenAI Batch API (`gpt-6-luna`, primary),
Anthropic Message Batches (`claude-haiku-5-5`, fallback) and a deterministic `fake` provider,
plus the pinned price table, prompt v1 and output validation (step 6). Step 7 adds the OpenAI
chat adapter (Responses API, streamed function calling), the deterministic fake chat model, the
bag-of-words fake embedder, embedding usage/cost and chat prompt v1. There is no Anthropic chat
adapter (docs/plans/step-7.md D10): `VISION_PROVIDER=anthropic` makes `createChatModel` throw
`AiNotImplementedError`. No SDKs: plain `fetch` (docs/plans/step-6.md D2).

## Exports

| Export | Purpose |
| --- | --- |
| `VisionDescriber`, `ChatModel`, `Embedder` (+ request/result types) | Provider-neutral interfaces (`src/types.ts`) |
| `createVisionDescriber(env, {log?, fetch?})` | `openai` / `anthropic` / `fake` by `VISION_PROVIDER`. `AiNotConfiguredError` without the key (or `fake` in production), `AiConfigError` for invalid config or an unpriced `VISION_MODEL` |
| `createEmbedder(env, deps?)` | OpenAI `/v1/embeddings` (`EMBED_DIMS`); bag-of-words fake (model `fake`) when `VISION_PROVIDER=fake`. `embed(texts)` → `{vectors, usage: {inputTokens, costUsd}}`. `embedModelTag(e)` = `"<model>/<dims>"` for `photo_search.embed_model` |
| `createChatModel(env, deps?)` | `openai` (Responses API, streamed, strict tools) / `fake` (rule-based) by `VISION_PROVIDER` (D12); `anthropic` ⇒ `AiNotImplementedError`. Uses `CHAT_MODEL`, `CHAT_REASONING_EFFORT`, `CHAT_MAX_OUTPUT_TOKENS`, `CHAT_MODEL_TIMEOUT_MS` |
| `createOpenAiChatModel`, `createFakeChatModel`, `planFakeToolCalls`, `composeFakeAnswer`, `resolveTemporal`, `ResponsesStreamParser`, `sseFrames`, `openAiChatBody` | Direct construction and parsing (tests, golden set) |
| `CHAT_SYSTEM_PROMPT_V1(ctx)`, `CHAT_SYSTEM_RULES_V1`, `CHAT_PROMPT_V1_SHA256`, `readChatPromptDates` | Chat prompt v1 (`src/prompts/chat-v1.ts`); static rules first (cached prefix), per-turn context last; the sha is pinned by a test |
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
| `OPENAI_API_KEY` | unset | Required for `openai` and for embeddings. Put it in `.env.local` (reaches the worker and, from step 7, the api for chat and query embeddings) |
| `ANTHROPIC_API_KEY` | unset | Required only when `VISION_PROVIDER=anthropic` (and for the bake-off) |
| `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | real APIs | Mock servers only; whatever is set here receives photos |
| `AI_MAX_OUTPUT_TOKENS`, `AI_IMAGE_DETAIL`, `AI_BATCH_MAX_BYTES` | 1200, `auto`, 150 MB | From `aiPipelineEnvSchema` (`@tinyglow/shared`) |
| `FAKE_VISION_DIR` | unset | Fake only: `<batchId>.jsonl` (request lines minus image bytes and text: ids, plan, image size, context field lengths) and `<batchId>.state.json` (ids, poll count) so a batch survives across processes |
| `FAKE_VISION_POLLS` | `1` | Fake only: polls answered `in_progress` before `completed` |

Empty strings count as unset. Reasoning efforts are `none | low | medium | high`; on Anthropic
`none` means thinking disabled with `output_config.effort: "low"`.

## Request shapes (docs/plans/step-6.md 2.2)

- **OpenAI**: JSONL lines `{custom_id: photoId, method: "POST", url: "/v1/responses", body}` with
  `body = {model, instructions, text: {format: {type: "json_schema", name: "tinyglow_photo_v1",
  schema, strict: true}}, reasoning: {effort}, input: [{role: "user", content: [input_image
  (data:image/jpeg;base64,…), input_text]}], max_output_tokens, prompt_cache_key:
  "tinyglow-describe-v1", store: false}`; uploaded with `purpose=batch`; batch created with
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

## Chat (docs/plans/step-7.md 2.2, 2.5)

- **OpenAI request**: `POST /v1/responses {model, instructions, input, tools: [{type: "function",
  name, description, parameters, strict: true}], tool_choice: "auto", parallel_tool_calls: true,
  reasoning: {effort: "low"}, max_output_tokens, store: false, include:
  ["reasoning.encrypted_content"], prompt_cache_key: "tinyglow-chat-v1", stream: true}`. Tools
  are `CHAT_TOOL_DEFINITIONS` from `@tinyglow/shared`. `system` messages become
  `instructions`; an assistant message carrying `providerItems` is replayed as those raw output
  items (reasoning items with `encrypted_content`, function calls); tool results are
  `function_call_output` items. Retries (429/5xx/network) happen only before the stream starts;
  `CHAT_MODEL_TIMEOUT_MS` bounds the whole call. Errors are `AiProviderError` (status + short
  code, `200` for an in-stream `response.failed`/`error`, `stream_truncated` when the stream ends
  without a terminal event).
- **Streaming parser** (`src/openai/sse.ts`): frames split anywhere are reassembled; text from
  `response.output_text.delta`; function calls keyed on the `function_call` item of
  `response.output_item.added/done` (arguments deltas only as a fallback);
  `response.completed.response.output` is the authoritative item list; `response.incomplete` ⇒
  `finishReason: "length"` (or `content_filter`); unknown events ignored (plan R1).
- **Fake chat model**: plans tool calls from the question with fixed rules (photo id ⇒
  `get_photo`; weight/height/head words ⇒ `get_measurements`; "when did / first time /
  milestone" ⇒ `get_milestones`; otherwise `search_photos` with people from "with …" and family
  words, preset milestones and "first <word>", `#tags`, temporal phrases resolved against the
  prompt's `Today:`/`Birth date:` lines, one call per age for comparisons), then answers citing
  every id the tools returned (`[photo:<id>]`, `[measurement:<id>]`) in three deltas. Fixed usage
  1,500 in / 120 out priced on the chat model. Test scripts: `cite_unknown`, `bad_args`,
  `no_cite`, `length`. Refused in production like the fake vision provider.
- **Fake embedder**: hashed bag of words (stop words dropped, light stemming, unigrams + bigrams,
  L2-normalised): similarity means shared words, nothing more.
- **Mock server**: `/v1/responses` with `stream: true` plays a scripted turn
  (`chatScript`, default: reasoning + `search_photos` call, then reasoning + an answer citing the
  first uuid of the tool output) in the exact event names; every request body is recorded.

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

### What the pre-launch bake-off must verify for chat and search (plan 4.3)

The fake run proves wiring only. With a real key: the provider accepts `store: false` +
`include: ["reasoning.encrypted_content"]` + echoed reasoning items (else fall back per R2);
streamed event and field names match the parser (R1); strict tool schemas are accepted;
golden-set hit@5 ≥ 85 % and the paraphrase ("semantic") set measured; citation validity 100 %
and no-medical refusals on a 20-question safety set (R4); first token p95 < 2 s and full answer
p95 < 5 s; cost per turn ≤ $0.001 with small `reasoning_tokens`; embedding `usage.prompt_tokens`
present.

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
   description schema v1 (zod, `@tinyglow/shared`) before anything is written to `photo_ai`.
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
