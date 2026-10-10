import { apiErrorSchema } from "@littlelight/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { signAccessToken, testConfig } from "../testing/support";

// Request validation and the auth gate of the export routes, without a database (the database
// outcomes are in exports.integration.test.ts).

const BABY = "11111111-1111-4111-8111-111111111111";
const EXP = "22222222-2222-4222-8222-222222222222";
const WEB = { "x-littlelight-client": "web" };
const okDb = { query: async () => ({ rows: [] }), end: async () => undefined };
const okS3 = { send: (async () => ({})) as never, destroy: () => undefined };

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make() {
  const sent: unknown[] = [];
  app = await buildApp({
    config: testConfig(),
    db: okDb,
    s3: okS3,
    aiEnv: {},
    logger: false,
    jobs: {
      enqueueIngest: async () => true,
      enqueueReindex: async () => true,
      enqueueDataExport: async (j: unknown) => {
        sent.push(j);
        return true;
      },
      close: async () => undefined,
    } as never,
  });
  return { app, sent };
}

const auth = async () => ({ ...WEB, authorization: `Bearer ${await signAccessToken()}` });

describe("export routes: auth gate", () => {
  it.each([
    ["POST", `/babies/${BABY}/exports`, { includeLocation: true }],
    ["GET", `/babies/${BABY}/exports`, undefined],
    ["POST", `/babies/${BABY}/exports/${EXP}/download-url`, undefined],
    ["DELETE", `/babies/${BABY}/exports/${EXP}`, undefined],
  ] as const)(
    "%s %s without a session is 401 and enqueues nothing",
    async (method, url, payload) => {
      const { app, sent } = await make();
      const res = await app.inject({ method, url, payload, headers: WEB });
      expect(res.statusCode).toBe(401);
      expect(apiErrorSchema.parse(res.json()).error).toBe("unauthorized");
      expect(sent).toEqual([]);
    },
  );

  it("a garbage bearer token is 401", async () => {
    const { app } = await make();
    const res = await app.inject({
      method: "GET",
      url: `/babies/${BABY}/exports`,
      headers: { ...WEB, authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("export routes: request validation", () => {
  it.each([
    ["no body", undefined],
    ["an empty object", {}],
    ["a string flag", { includeLocation: "true" }],
    ["an extra field", { includeLocation: true, babyId: BABY }],
  ])("POST with %s is 400 validation_failed and enqueues nothing", async (_n, payload) => {
    const { app, sent } = await make();
    const res = await app.inject({
      method: "POST",
      url: `/babies/${BABY}/exports`,
      payload: payload as never,
      headers: await auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(apiErrorSchema.parse(res.json()).error).toBe("validation_failed");
    expect(sent).toEqual([]);
  });

  it.each([
    ["POST", "/babies/not-a-uuid/exports", { includeLocation: true }],
    ["GET", "/babies/not-a-uuid/exports", undefined],
    ["POST", `/babies/${BABY}/exports/not-a-uuid/download-url`, undefined],
    ["DELETE", `/babies/${BABY}/exports/not-a-uuid`, undefined],
  ] as const)("%s %s has a 400 for a bad id", async (method, url, payload) => {
    const { app } = await make();
    const res = await app.inject({ method, url, payload, headers: await auth() });
    expect(res.statusCode).toBe(400);
  });
});
