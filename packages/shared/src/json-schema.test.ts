import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AI_DESCRIPTION_V1_JSON_SCHEMA } from "./ai-description";
import {
  deepFreeze,
  STRICT_JSON_SCHEMA_FORBIDDEN_KEYWORDS,
  strictJsonSchemaPostProcess,
  toStrictJsonSchema,
} from "./json-schema";

describe("AI_DESCRIPTION_V1_JSON_SCHEMA stays byte-identical (provider prompt-cache prefix)", () => {
  it("serialises to 2935 bytes with the pinned sha256", () => {
    const json = JSON.stringify(AI_DESCRIPTION_V1_JSON_SCHEMA);
    expect(Buffer.byteLength(json)).toBe(2935);
    expect(createHash("sha256").update(json).digest("hex")).toBe(
      "43b6779998de40c39436f3312c3cb79c638697033027326b2c79976f47fdb516",
    );
  });

  it("is deep-frozen", () => {
    expect(Object.isFrozen(AI_DESCRIPTION_V1_JSON_SCHEMA)).toBe(true);
    const props = AI_DESCRIPTION_V1_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.isFrozen(props)).toBe(true);
  });
});

describe("toStrictJsonSchema", () => {
  it("makes every property required and forbids additional ones, recursively", () => {
    const s = toStrictJsonSchema(
      z.strictObject({ a: z.string(), inner: z.strictObject({ b: z.number().nullable() }) }),
    ) as {
      required: string[];
      additionalProperties: boolean;
      properties: { inner: { required: string[]; additionalProperties: boolean } };
    };
    expect(s.required).toEqual(["a", "inner"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.inner.required).toEqual(["b"]);
    expect(s.properties.inner.additionalProperties).toBe(false);
  });

  it("emits a nullable plain type as type: [T, 'null']", () => {
    const s = toStrictJsonSchema(z.strictObject({ n: z.string().nullable() })) as {
      properties: { n: { type: unknown } };
    };
    expect(s.properties.n.type).toEqual(["string", "null"]);
  });

  it("emits a nullable enum as type: [string, 'null'] with null in enum (step 7 tool args)", () => {
    const s = toStrictJsonSchema(
      z.strictObject({ kind: z.enum(["weight", "height", "head"]).nullable() }),
    ) as { properties: { kind: { type: unknown; enum: unknown[]; anyOf?: unknown } } };
    expect(s.properties.kind.type).toEqual(["string", "null"]);
    expect(s.properties.kind.enum).toEqual(["weight", "height", "head", null]);
    expect(s.properties.kind.anyOf).toBeUndefined();
  });

  it("does not duplicate null when the enum already has it", () => {
    const out = strictJsonSchemaPostProcess({
      anyOf: [{ type: "string", enum: ["a", null] }, { type: "null" }],
    }) as { enum: unknown[] };
    expect(out.enum.filter((v) => v === null)).toHaveLength(1);
  });

  it("drops bounds, formats, patterns and defaults, and $schema", () => {
    const s = toStrictJsonSchema(
      z.strictObject({
        a: z.string().min(1).max(5).regex(/x/),
        b: z.number().int().min(1).max(5),
        c: z.array(z.string()).max(3),
        d: z.uuid(),
      }),
    );
    const json = JSON.stringify(s);
    for (const k of STRICT_JSON_SCHEMA_FORBIDDEN_KEYWORDS) {
      expect(json, k).not.toContain(`"${k}"`);
    }
    expect(json).not.toContain("$schema");
  });

  it("caps minItems at 1", () => {
    const s = toStrictJsonSchema(z.strictObject({ l: z.array(z.string()).min(3) })) as {
      properties: { l: { minItems: number } };
    };
    expect(s.properties.l.minItems).toBe(1);
  });

  it("is pure: post-processing does not mutate its input", () => {
    const input = { type: "object", properties: { a: { type: "string", maxLength: 3 } } };
    const copy = structuredClone(input);
    strictJsonSchemaPostProcess(input);
    expect(input).toEqual(copy);
  });

  it("leaves scalars and arrays of scalars alone", () => {
    expect(strictJsonSchemaPostProcess("x")).toBe("x");
    expect(strictJsonSchemaPostProcess([1, "a"])).toEqual([1, "a"]);
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays and returns the same reference", () => {
    const v = { a: { b: [1, { c: 2 }] } };
    expect(deepFreeze(v)).toBe(v);
    expect(Object.isFrozen(v.a.b[1])).toBe(true);
    expect(Object.isFrozen(v.a.b)).toBe(true);
  });
});
