import {
  AI_DESCRIPTION_V1_JSON_SCHEMA,
  AI_DESCRIPTION_V1_SCHEMA_NAME,
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
} from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import { analysisImage, craftJpeg } from "../../../e2e/fixtures/ai-images";
import { AiRequestError } from "./errors";
import { DESCRIBE_SYSTEM_PROMPT_V1 } from "./prompts/describe-v1";
import {
  anthropicMessageParams,
  assembleVisionRequest,
  checkVisionBatch,
  checkVisionRequest,
  estimateVisionRequestBytes,
  openAiResponsesBody,
  promptCacheKey,
  sanitizeVisionContext,
  systemPromptFor,
} from "./request";
import type { VisionContext, VisionRequest } from "./types";

// Loosely typed JSON as read back from recorded requests.
// biome-ignore lint/suspicious/noExplicitAny: test-only access to wire JSON
type Rec = Record<string, any>;

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ctx = (over: Partial<VisionContext> = {}): VisionContext => ({
  babyAgeDays: 100,
  takenAt: "2026-06-14",
  placeLabel: "Riverside Park",
  people: ["Grandma"],
  milestone: null,
  parentNotes: "first picnic",
  ...over,
});
const req = (over: Partial<VisionRequest> = {}): VisionRequest => ({
  photoId: ID,
  plan: "paid",
  image: analysisImage(),
  context: ctx(),
  promptVersion: AI_PROMPT_VERSION,
  schemaVersion: AI_SCHEMA_VERSION,
  ...over,
});
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AiRequestError);
    return (e as AiRequestError).code;
  }
  return null;
};

describe("openAiResponsesBody", () => {
  const body = openAiResponsesBody(req(), {
    model: "gpt-6-luna",
    reasoningEffort: "none",
    maxOutputTokens: 1200,
  }) as Rec;

  it("has the exact structured shape", () => {
    expect(body.model).toBe("gpt-6-luna");
    expect(body.instructions).toBe(DESCRIBE_SYSTEM_PROMPT_V1);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(1200);
    expect(body.prompt_cache_key).toBe(promptCacheKey(AI_PROMPT_VERSION));
    expect(body.text.format).toEqual({
      type: "json_schema",
      name: AI_DESCRIPTION_V1_SCHEMA_NAME,
      schema: AI_DESCRIPTION_V1_JSON_SCHEMA,
      strict: true,
    });
  });

  it("sends the image first as a base64 data URL, then the context text", () => {
    const content = body.input[0].content;
    expect(body.input[0].role).toBe("user");
    expect(content[0].type).toBe("input_image");
    expect(content[0].image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(content[0].detail).toBe("auto");
    expect(content[1].type).toBe("input_text");
    expect(content[1].text).toContain("Riverside Park");
  });

  it("carries no gps / coordinate / baby-name key anywhere", () => {
    const s = JSON.stringify({
      ...body,
      input: [{ ...body.input[0], content: [body.input[0].content[1]] }],
    });
    expect(s).not.toMatch(/latitude|longitude|gps/i);
  });
});

describe("anthropicMessageParams", () => {
  it("effort none: thinking disabled, output_config.effort low, 1h cached system, json_schema", () => {
    const p = anthropicMessageParams(req(), {
      model: "claude-haiku-5-5",
      reasoningEffort: "none",
      maxOutputTokens: 1200,
    }) as Rec;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.max_tokens).toBe(1200);
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p.system[0].text).toBe(DESCRIBE_SYSTEM_PROMPT_V1);
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.output_config.format.schema).toEqual(AI_DESCRIPTION_V1_JSON_SCHEMA);
    expect(p.output_config.effort).toBe("low");
    expect(p.thinking).toEqual({ type: "disabled" });
    expect("temperature" in p || "top_p" in p || "top_k" in p).toBe(false);
    expect(p.messages[0].content[0].source.type).toBe("base64");
    expect(p.messages[0].content[0].source.media_type).toBe("image/jpeg");
  });
  it("effort high: adaptive thinking", () => {
    const p = anthropicMessageParams(req(), {
      model: "claude-haiku-5-5",
      reasoningEffort: "high",
      maxOutputTokens: 1200,
    }) as Rec;
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config.effort).toBe("high");
  });
});

describe("request guards", () => {
  it("free plan: a runtime throw even when cast past the type", () => {
    expect(codeOf(() => checkVisionRequest(req({ plan: "free" as never })))).toBe("not_paid");
    expect(codeOf(() => assembleVisionRequest({ ...req(), plan: "free" as never }))).toBe(
      "not_paid",
    );
    expect(codeOf(() => checkVisionRequest(req({ plan: undefined as never })))).toBe("not_paid");
  });
  it("an image over 768 px or 400 KB throws", () => {
    expect(
      codeOf(() =>
        checkVisionRequest(
          req({
            image: { bytes: craftJpeg(800, 600), mimeType: "image/jpeg", width: 800, height: 600 },
          }),
        ),
      ),
    ).toBe("image_too_large");
    expect(
      codeOf(() =>
        checkVisionRequest(
          req({
            image: {
              bytes: craftJpeg(768, 576, 500_000),
              mimeType: "image/jpeg",
              width: 768,
              height: 576,
            },
          }),
        ),
      ),
    ).toBe("image_too_many_bytes");
  });
  it("header / size mismatch throws", () => {
    expect(
      codeOf(() => checkVisionRequest(req({ image: { ...analysisImage(), height: 100 } }))),
    ).toBe("image_dimensions_mismatch");
  });
  it("bad photo ids and unsupported versions throw", () => {
    expect(codeOf(() => checkVisionRequest(req({ photoId: "has space" })))).toBe(
      "invalid_photo_id",
    );
    expect(codeOf(() => checkVisionRequest(req({ photoId: "x".repeat(65) })))).toBe(
      "invalid_photo_id",
    );
    expect(codeOf(() => checkVisionRequest(req({ promptVersion: "v9" })))).toBe(
      "unsupported_version",
    );
    expect(codeOf(() => systemPromptFor("v1", "v2"))).toBe("unsupported_version");
  });
  it("coordinate tripwire blanks the field, warns with a category, and never forwards the text", () => {
    const { request, warnings } = checkVisionRequest(
      req({
        context: ctx({
          parentNotes: "taken at 47.6062, -122.3321",
          placeLabel: "47.6062 -122.3321",
        }),
      }),
    );
    expect(request.context.parentNotes).toBeNull();
    expect(request.context.placeLabel).toBeNull();
    expect(warnings).toEqual(["context_coordinates_blanked"]);
    expect(JSON.stringify(request.context)).not.toContain("47.6062");
    const body = JSON.stringify(
      openAiResponsesBody(request, {
        model: "gpt-6-luna",
        reasoningEffort: "none",
        maxOutputTokens: 100,
      }),
    );
    expect(body).not.toContain("47.6062");
  });
  it("leaves 'Riverside Park, 2 pm' alone, also in people / milestone checks", () => {
    const { context, warnings } = sanitizeVisionContext(
      ctx({ placeLabel: "Riverside Park, 2 pm" }),
    );
    expect(context.placeLabel).toBe("Riverside Park, 2 pm");
    expect(warnings).toEqual([]);
    const s = sanitizeVisionContext(
      ctx({ people: ["Grandma", "47.60621 -122.33211"], milestone: "gps spot" }),
    );
    expect(s.context.people).toEqual(["Grandma"]);
    expect(s.context.milestone).toBeNull();
  });
  it("drops an unparseable takenAt with a warning instead of failing", () => {
    const { context, warnings } = sanitizeVisionContext(ctx({ takenAt: "yesterday" }));
    expect(context.takenAt).toBeNull();
    expect(warnings).toContain("context_taken_at_dropped");
  });
  it("trims, clips and drops empty people", () => {
    const { context } = sanitizeVisionContext(
      ctx({ people: ["  ", "A", 5 as never], parentNotes: "  " }),
    );
    expect(context.people).toEqual(["A"]);
    expect(context.parentNotes).toBeNull();
  });
});

describe("checkVisionBatch", () => {
  it("rejects empty, duplicate ids and mixed versions", () => {
    expect(codeOf(() => checkVisionBatch([]))).toBe("batch_empty");
    expect(codeOf(() => checkVisionBatch([req(), req()]))).toBe("duplicate_photo_id");
    expect(
      codeOf(() => checkVisionBatch([req(), req({ photoId: "b", schemaVersion: "v2" })])),
    ).toBe("unsupported_version");
  });
  it("one free request poisons the whole batch (nothing is sent)", () => {
    expect(
      codeOf(() => checkVisionBatch([req(), req({ photoId: "b", plan: "free" as never })])),
    ).toBe("not_paid");
  });
  it("returns sanitised requests and per-photo warnings", () => {
    const out = checkVisionBatch([req({ context: ctx({ parentNotes: "latitude 1" }) })]);
    expect(out.warnings).toEqual([{ photoId: ID, warning: "context_coordinates_blanked" }]);
    expect(out.requests[0]?.context.parentNotes).toBeNull();
  });
});

describe("estimateVisionRequestBytes", () => {
  it("is at least the base64 size", () => {
    const r = req();
    expect(estimateVisionRequestBytes(r)).toBeGreaterThan(
      Math.ceil(r.image.bytes.byteLength / 3) * 4,
    );
  });
});
