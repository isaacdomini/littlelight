import { Writable } from "node:stream";
import {
  type ChatModel,
  createFakeChatModel,
  createFakeEmbedder,
  type FakeChatScript,
  getAiStatus,
} from "@littlelight/ai";
import {
  apiErrorSchema,
  CHAT_MESSAGES,
  type ChatEvent,
  chatThreadResponseSchema,
  chatTurnResponseSchema,
  decodeChatEventFrame,
} from "@littlelight/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loggerOptions } from "../app";
import type { AiServices } from "../plugins/ai";
import { createHarness, databaseUrl, type Harness, type TestUser } from "../testing/integration";
import { seedPhoto } from "../testing/photos";
import { seedDetails, seedMeasurement, seedSearchRow } from "../testing/search";
import { testConfig } from "../testing/support";

// Chat turns against a real database (docs/plans/step-7.md 2.12; PRD FR-7.1-7.7, "Cost
// controls"). The model is the deterministic fake chat model, the embedder the bag-of-words
// fake, both injected through `BuildAppOptions.ai`; nothing here reads a key or calls a provider.

const QUESTION_SENTINEL = "SENTINEL-QUESTION-4471";
const SECRET_NOTE = "PRIVATE-NOTE-9913";
const accept = { accept: "application/json" };
const sse = { accept: "text/event-stream" };

const fakeChat = (script?: FakeChatScript): ChatModel =>
  createFakeChatModel({ delayMs: 0, env: {}, ...(script ? { script } : {}) });

describe.skipIf(!databaseUrl)("chat routes (api + db)", () => {
  let h: Harness;
  let mom: TestUser;
  let dad: TestUser;
  let nanny: TestUser;
  let stranger: TestUser;
  let freeAdmin: TestUser;
  let baby: string;
  let freeBaby: string;
  const ph: Record<string, string> = {};
  let measurementId: string;
  const logs: string[] = [];
  const modelCalls = vi.fn();

  const ai: AiServices = {
    chat: null,
    embedder: createFakeEmbedder({ dims: 1024 }),
    status: getAiStatus({ VISION_PROVIDER: "fake" }),
    chatReasoningEffort: "low",
  };
  /** Counts model calls, then delegates to a fake with the given script. */
  function useChat(script?: FakeChatScript, gate?: Promise<void>): void {
    const inner = fakeChat(script);
    ai.chat = {
      provider: inner.provider,
      model: inner.model,
      complete: inner.complete,
      async *stream(messages, tools, options) {
        modelCalls();
        if (gate) await gate;
        yield* inner.stream(messages, tools, options);
      },
    };
  }

  const post = (u: TestUser | null, babyId: string, text: string, headers = accept) =>
    h.inject(u, "POST", `/babies/${babyId}/chat/messages`, { text }, headers);
  const thread = (u: TestUser | null, babyId: string) =>
    h.inject(u, "GET", `/babies/${babyId}/chat/thread`);
  const clear = (u: TestUser | null, babyId: string) =>
    h.inject(u, "DELETE", `/babies/${babyId}/chat/thread`);
  const resetMomChat = async () => {
    await h.admin.query("DELETE FROM public.chat_threads WHERE baby_id = $1", [baby]);
    await h.admin.query("DELETE FROM public.chat_turns WHERE user_id = $1", [mom.id]);
    await h.admin.query("DELETE FROM public.ai_spend WHERE baby_id = $1", [baby]);
    await h.admin.query(
      "DELETE FROM public.audit_log WHERE baby_id = $1 AND event IN ('chat.cleared')",
      [baby],
    );
    logs.length = 0;
  };
  const parseSse = (body: string): ChatEvent[] =>
    body
      .split("\n\n")
      .map((f) => decodeChatEventFrame(f))
      .filter((e): e is ChatEvent => e !== null);

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    h = await createHarness({
      ai,
      config: { LOG_LEVEL: "info" },
      logger: { ...loggerOptions(testConfig()), level: "info", stream },
    });
    mom = await h.user();
    dad = await h.user();
    nanny = await h.user();
    stranger = await h.user();
    freeAdmin = await h.user();
    baby = await h.baby(mom, "Plus baby");
    freeBaby = await h.baby(freeAdmin, "Free baby");
    await h.member(baby, dad, "admin");
    await h.member(baby, nanny, "contributor");
    await h.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [baby]);

    const mk = async (key: string, o: Parameters<typeof seedPhoto>[2] = {}) => {
      ph[key] = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        status: "ingested",
        withThumb: true,
        ...o,
      });
    };
    await mk("bath", { takenAt: "2026-06-10T12:00:00Z" });
    await mk("park", { takenAt: "2026-07-20T12:00:00Z" });
    await mk("weigh", { takenAt: "2026-09-01T12:00:00Z" });
    await seedSearchRow(h.admin, {
      photoId: ph.bath as string,
      babyId: baby,
      text: "Baby splashing in the bath with a yellow duck.",
      tags: ["bath"],
      people: ["Dad"],
      ageDays: 101,
    });
    await seedSearchRow(h.admin, {
      photoId: ph.park as string,
      babyId: baby,
      text: `Walking in the park with Grandma. Note from parent: "${SECRET_NOTE}"`,
      tags: ["park"],
      people: ["Grandma"],
      takenAt: "2026-07-20T12:00:00Z",
      ageDays: 141,
    });
    await seedDetails(h.admin, ph.park as string, {
      note: SECRET_NOTE,
      people: ["Grandma"],
      editedBy: mom.id,
    });
    measurementId = await seedMeasurement(h.admin, {
      babyId: baby,
      photoId: ph.weigh as string,
      kind: "weight",
      valueMetric: 7200,
      measuredAt: "2026-09-01T09:00:00Z",
      createdBy: mom.id,
    });
    await seedMeasurement(h.admin, {
      babyId: baby,
      kind: "weight",
      valueMetric: 6100,
      measuredAt: "2026-07-01T09:00:00Z",
      createdBy: mom.id,
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  describe("access: every chat route", () => {
    it("a contributor and a stranger are refused on all three routes, before any model call", async () => {
      useChat();
      modelCalls.mockClear();
      const cases: [TestUser, string, number, string][] = [
        [nanny, baby, 403, "forbidden"],
        [stranger, baby, 404, "not_found"],
      ];
      for (const [u, b, status, code] of cases) {
        for (const res of [await thread(u, b), await post(u, b, "hello"), await clear(u, b)]) {
          expect(res.statusCode, `${code} ${res.body}`).toBe(status);
          expect(apiErrorSchema.parse(res.json()).error).toBe(code);
        }
      }
      expect(modelCalls).not.toHaveBeenCalled();
    });

    it("a free-tier admin can send nothing (plan_required) but can read and clear their history", async () => {
      useChat();
      modelCalls.mockClear();
      const post403 = await post(freeAdmin, freeBaby, "hello");
      expect(post403.statusCode).toBe(403);
      expect(apiErrorSchema.parse(post403.json()).error).toBe("plan_required");
      expect(modelCalls).not.toHaveBeenCalled();

      // History left over from when the album was on Plus.
      const t = await h.admin.query(
        "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2) RETURNING id",
        [freeBaby, freeAdmin.id],
      );
      await h.admin.query(
        "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'old question')",
        [t.rows[0].id, freeBaby, freeAdmin.id],
      );
      const read = await thread(freeAdmin, freeBaby);
      expect(read.statusCode).toBe(200);
      expect(chatThreadResponseSchema.parse(read.json()).messages).toHaveLength(1);
      const del = await clear(freeAdmin, freeBaby);
      expect(del.statusCode).toBe(204);
      const gone = await h.admin.query(
        "SELECT count(*)::int AS n FROM public.chat_messages WHERE baby_id = $1",
        [freeBaby],
      );
      expect(gone.rows[0].n).toBe(0);
      expect(modelCalls).not.toHaveBeenCalled();
    });

    it("another user's history is never readable or clearable, even by an admin of the same album", async () => {
      useChat();
      const t = await h.admin.query(
        "INSERT INTO public.chat_threads (baby_id, user_id) VALUES ($1, $2) RETURNING id",
        [freeBaby, freeAdmin.id],
      );
      await h.admin.query(
        "INSERT INTO public.chat_messages (thread_id, baby_id, user_id, role, content) VALUES ($1, $2, $3, 'user', 'private')",
        [t.rows[0].id, freeBaby, freeAdmin.id],
      );
      const co = await h.user();
      await h.member(freeBaby, co, "admin");
      const read = await thread(co, freeBaby);
      expect(read.statusCode).toBe(200);
      expect(chatThreadResponseSchema.parse(read.json()).messages).toEqual([]);
      expect(read.body).not.toContain("private");
      expect((await clear(co, freeBaby)).statusCode).toBe(204);
      const still = await h.admin.query(
        "SELECT count(*)::int AS n FROM public.chat_messages WHERE baby_id = $1",
        [freeBaby],
      );
      expect(still.rows[0].n).toBe(1);
      await h.admin.query("DELETE FROM public.chat_threads WHERE baby_id = $1", [freeBaby]);
    });

    it("an expired entitlement is plan_required for sending, while history stays readable and clearable", async () => {
      const lapsed = await h.baby(mom, "Lapsed");
      await h.admin.query(
        "UPDATE public.babies SET plan = 'plus', entitlement_expires_at = now() + interval '1 day' WHERE id = $1",
        [lapsed],
      );
      expect((await post(mom, lapsed, "hi")).statusCode).toBe(200);
      await h.admin.query(
        "UPDATE public.babies SET entitlement_expires_at = now() - interval '1 hour' WHERE id = $1",
        [lapsed],
      );
      modelCalls.mockClear();
      const res = await post(mom, lapsed, "hi");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("plan_required");
      expect(modelCalls).not.toHaveBeenCalled();
      const read = await thread(mom, lapsed);
      expect(read.statusCode).toBe(200);
      expect(chatThreadResponseSchema.parse(read.json()).messages.length).toBeGreaterThan(0);
      expect((await clear(mom, lapsed)).statusCode).toBe(204);
      expect(chatThreadResponseSchema.parse((await thread(mom, lapsed)).json()).messages).toEqual(
        [],
      );
    });

    it("requires sign-in; a share-link viewer token cannot reach any chat route", async () => {
      expect((await post(null, baby, "hi")).statusCode).toBe(401);
      expect((await thread(null, baby)).statusCode).toBe(401);
      expect((await clear(null, baby)).statusCode).toBe(401);
      const { signAccessToken } = await import("../testing/support");
      const viewerToken = await signAccessToken({
        sub: "",
        role: "viewer",
        email: null,
        sessionId: null,
        extra: { share_link_id: "11111111-1111-4111-8111-111111111111" },
      });
      for (const res of [
        await h.app.inject({
          method: "GET",
          url: `/babies/${baby}/chat/thread`,
          headers: { authorization: `Bearer ${viewerToken}` },
        }),
        await h.app.inject({
          method: "POST",
          url: `/babies/${baby}/chat/messages`,
          headers: { authorization: `Bearer ${viewerToken}`, ...accept },
          payload: { text: "hi" },
        }),
      ]) {
        expect([401, 403]).toContain(res.statusCode);
      }
    });

    it("chat that is not configured on the server is a 409 after the gate (strangers still get 404)", async () => {
      await resetMomChat();
      ai.chat = null;
      const res = await post(mom, baby, "hello");
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe(CHAT_MESSAGES.notConfigured);
      expect((await post(stranger, baby, "hello")).statusCode).toBe(404);
      // nothing was stored and no turn was spent
      const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(t.messages).toEqual([]);
      expect(t.turnsLeftToday).toBe(100);
    });

    it("validates the message: empty, blank, too long and unknown shape are 400", async () => {
      useChat();
      for (const text of ["", "   ", "x".repeat(1001)]) {
        expect((await post(mom, baby, text)).statusCode, JSON.stringify(text.length)).toBe(400);
      }
      expect(
        (await h.inject(mom, "POST", `/babies/${baby}/chat/messages`, {}, accept)).statusCode,
      ).toBe(400);
      expect((await post(mom, baby, "x".repeat(1000))).statusCode).toBe(200);
      await resetMomChat();
    });
  });

  describe("a turn in JSON mode", () => {
    it("answers from tool results: photos are a subset of what the search returned, citations are clean", async () => {
      await resetMomChat();
      useChat();
      const res = await post(mom, baby, "show me the bath");
      expect(res.statusCode, res.body).toBe(200);
      const out = chatTurnResponseSchema.parse(res.json());
      expect(out.message.role).toBe("assistant");
      expect(out.message.text).not.toMatch(/\[photo:|\[measurement:/);
      expect(out.message.text).toMatch(/^Here (are|is) \d+ photos? that match?/);
      expect(out.toolsUsed).toEqual(["search_photos"]);
      expect(out.message.status).toBe("complete");
      expect(out.message.grounded).toBe(true);
      expect(out.message.citations.photoIds).toContain(ph.bath);
      const grid = out.message.photos.map((p) => p.id);
      expect(grid).toContain(ph.bath);
      // every photo in the grid is one of the baby's indexed photos
      for (const id of grid) expect([ph.bath, ph.park]).toContain(id);
      expect(out.usage.costUsd).toBeGreaterThan(0);
      expect(out.usage.inputTokens).toBeGreaterThan(0);
      for (const p of out.message.photos) expect(p.thumbUrl).toMatch(/^https?:\/\//);
    });

    it("stores both messages, the tool names (not arguments) and a chat ai_spend row linked to the answer", async () => {
      await resetMomChat();
      useChat();
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "photos with Grandma")).json(),
      );
      const msgs = (
        await h.admin.query(
          "SELECT role, content, tools_used, status, cost_usd, cited_photo_ids FROM public.chat_messages WHERE baby_id = $1 ORDER BY created_at, id",
          [baby],
        )
      ).rows;
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs[0].content).toBe("photos with Grandma");
      expect(msgs[1].tools_used).toEqual(["search_photos"]);
      expect(msgs[1].status).toBe("complete");
      expect(Number(msgs[1].cost_usd)).toBeGreaterThan(0);
      expect(msgs[1].cited_photo_ids).toContain(ph.park);
      expect(JSON.stringify(msgs)).not.toContain("age_from_days");

      const spend = (
        await h.admin.query(
          "SELECT kind, user_id, ref_id, model, cost_usd, item_count, input_tokens, output_tokens FROM public.ai_spend WHERE baby_id = $1",
          [baby],
        )
      ).rows;
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({
        kind: "chat",
        user_id: mom.id,
        ref_id: out.message.id,
        model: "gpt-6-luna",
        item_count: 1, // fast path: one model call
      });
      expect(Number(spend[0].cost_usd)).toBeGreaterThan(0);
      expect(Number(spend[0].cost_usd)).toBeCloseTo(out.usage.costUsd, 8);
      // the month cost function now includes it
      const cost = await h.admin.query(
        "SELECT public.ai_baby_month_cost_usd($1, now()::date) AS c",
        [baby],
      );
      expect(Number(cost.rows[0].c)).toBeGreaterThanOrEqual(out.usage.costUsd);
    });

    it("a measurement question cites the measurement and its photo", async () => {
      await resetMomChat();
      useChat();
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "What was her weight in September 2026?")).json(),
      );
      expect(out.toolsUsed).toEqual(["get_measurements"]);
      expect(out.message.citations.measurementIds).toEqual([measurementId]);
      expect(out.message.citations.photoIds).toEqual([ph.weigh]);
      expect(out.message.text).toContain("7.20 kg");
      expect(out.message.text).not.toMatch(/\[/);
      const row = (
        await h.admin.query(
          "SELECT cited_measurement_ids FROM public.chat_messages WHERE role = 'assistant' AND baby_id = $1",
          [baby],
        )
      ).rows[0];
      expect(row.cited_measurement_ids).toEqual([measurementId]);
    });

    it("an unrelated question finds nothing and says so (relevance floor)", async () => {
      await resetMomChat();
      useChat();
      const out = chatTurnResponseSchema.parse((await post(mom, baby, "xylophone zebra")).json());
      expect(out.message.text).toBe(CHAT_MESSAGES.nothingFound);
      expect(out.message.photos).toEqual([]);
      expect(out.message.citations.photoIds).toEqual([]);
      expect(out.message.grounded).toBe(true);
    });

    it("a question whose filters match nothing says so (grounded, no photos)", async () => {
      await resetMomChat();
      useChat();
      // Filters run first: no photo was taken in 2020, so there is nothing to rank. (Without a
      // filter the vector leg always returns the nearest photos: there is no similarity cut-off.)
      const out = chatTurnResponseSchema.parse((await post(mom, baby, "photos in 2020")).json());
      expect(out.message.text).toBe(CHAT_MESSAGES.nothingFound);
      expect(out.message.photos).toEqual([]);
      expect(out.message.grounded).toBe(true);
    });

    it("cite_unknown: an id no tool returned is dropped, valid ones stay, and citationsDropped is logged", async () => {
      await resetMomChat();
      useChat("cite_unknown");
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "What is in the bath photo?")).json(),
      );
      expect(out.message.text).not.toMatch(/\[photo:/);
      for (const id of out.message.citations.photoIds) expect([ph.bath, ph.park]).toContain(id);
      const turnLine = logs
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((l) => l?.msg === "chat turn");
      expect(turnLine).toBeDefined();
      expect(turnLine?.citationsDropped).toBe(1);
    });

    it("bad_args: an invalid tool call is rejected to the model and the turn still completes", async () => {
      await resetMomChat();
      useChat("bad_args");
      const res = await post(mom, baby, "show me the bath");
      expect(res.statusCode).toBe(200);
      const out = chatTurnResponseSchema.parse(res.json());
      expect(out.message.status).toBe("complete");
      expect(out.message.text).toBe(CHAT_MESSAGES.nothingFound);
    });

    it("no_cite: the answer is flagged not grounded and the grid falls back to the search results", async () => {
      await resetMomChat();
      useChat("no_cite");
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "What is in the bath photo?")).json(),
      );
      expect(out.message.grounded).toBe(false);
      expect(out.message.citations.photoIds).toEqual([]);
      expect(out.message.photos.length).toBeGreaterThan(0);
    });

    it("a model failure is a stored error answer, not a 500; the turn still counts", async () => {
      await resetMomChat();
      ai.chat = {
        provider: "fake",
        model: "gpt-6-luna",
        complete: async () => {
          throw new Error("x");
        },
        // biome-ignore lint/correctness/useYield: fails before yielding
        async *stream() {
          throw Object.assign(new Error(`SECRET provider text ${QUESTION_SENTINEL}`), {
            code: "server_error",
            status: 500,
          });
        },
      };
      const res = await post(mom, baby, "hello there");
      expect(res.statusCode).toBe(200);
      const out = chatTurnResponseSchema.parse(res.json());
      expect(out.message.status).toBe("error");
      expect(out.message.text).toBe(CHAT_MESSAGES.failed);
      expect(res.body).not.toContain("SECRET");
      expect(logs.join("")).not.toContain("SECRET provider text");
      const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(t.turnsLeftToday).toBe(99);
      // an error answer is not fed back as history
      useChat();
      expect((await post(mom, baby, "show me the bath")).statusCode).toBe(200);
    });
  });

  describe("a turn over SSE", () => {
    it("events arrive as thread, status, photos, delta..., done; the text has no markers", async () => {
      await resetMomChat();
      useChat();
      const res = await post(mom, baby, "photos with Grandma", sse);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("no-store, no-transform");
      const events = parseSse(res.body);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("thread");
      expect(types.at(-1)).toBe("done");
      expect(types.filter((t) => t === "thread")).toHaveLength(1);
      expect(types.filter((t) => t === "done")).toHaveLength(1);
      expect(types).not.toContain("error");
      const firstDelta = types.indexOf("delta");
      const photos = types.indexOf("photos");
      const searching = events.findIndex((e) => e.type === "status" && e.stage === "searching");
      expect(types.indexOf("status")).toBeLessThan(searching);
      expect(searching).toBeLessThan(photos);
      expect(photos).toBeLessThan(firstDelta);
      for (const [i, t] of types.entries())
        if (i > firstDelta && i < types.length - 1) expect(t).toBe("delta");

      const text = events
        .filter((e): e is Extract<ChatEvent, { type: "delta" }> => e.type === "delta")
        .map((e) => e.text)
        .join("");
      expect(text).not.toMatch(/\[photo:|\[measurement:|photo:/);
      expect(res.body).not.toMatch(/\[photo:[0-9a-f-]{36}\]/);
      const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
      expect(done.message.text).toBe(text);
      expect(done.message.citations.photoIds).toContain(ph.park);
      const first = events[0] as Extract<ChatEvent, { type: "thread" }>;
      const stored = await h.admin.query(
        "SELECT id FROM public.chat_threads WHERE baby_id = $1 AND user_id = $2",
        [baby, mom.id],
      );
      expect(stored.rows[0].id).toBe(first.threadId);
      const photosEvent = events[photos] as Extract<ChatEvent, { type: "photos" }>;
      expect(photosEvent.photos.map((p) => p.id)).toContain(ph.park);
    });

    it("a failing model after the user message is stored: error event, then done with status error", async () => {
      await resetMomChat();
      ai.chat = {
        provider: "fake",
        model: "gpt-6-luna",
        complete: async () => {
          throw new Error("x");
        },
        // biome-ignore lint/correctness/useYield: fails before yielding
        async *stream() {
          throw new Error("down");
        },
      };
      const res = await post(mom, baby, "hello there", sse);
      expect(res.statusCode).toBe(200);
      const events = parseSse(res.body);
      const types = events.map((e) => e.type);
      expect(types).toContain("error");
      expect(types.at(-1)).toBe("done");
      expect(types.indexOf("error")).toBeLessThan(types.indexOf("done"));
      expect((events.at(-1) as Extract<ChatEvent, { type: "done" }>).message.status).toBe("error");
    });

    it("pre-stream failures are plain JSON errors, not an event stream", async () => {
      useChat();
      const res = await post(stranger, baby, "hi", sse);
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      const res2 = await post(nanny, baby, "hi", sse);
      expect(res2.statusCode).toBe(403);
    });
  });

  describe("thread, history and clearing", () => {
    it("GET thread: empty at first, then both messages oldest first with signed photos; clearing keeps the turn count", async () => {
      await resetMomChat();
      useChat();
      const empty = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(empty).toEqual({ threadId: null, messages: [], turnsLeftToday: 100 });

      await post(mom, baby, "photos with Grandma");
      await post(mom, baby, "show me the bath");
      const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(t.threadId).not.toBeNull();
      expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(t.messages[0]?.text).toBe("photos with Grandma");
      expect(t.messages[1]?.photos.map((p) => p.id)).toContain(ph.park);
      expect(t.messages[0]?.photos).toEqual([]);
      expect(t.turnsLeftToday).toBe(98);

      // another admin of the same baby has their own, empty thread
      const dadThread = chatThreadResponseSchema.parse((await thread(dad, baby)).json());
      expect(dadThread.messages).toEqual([]);
      expect(dadThread.turnsLeftToday).toBe(100);

      const del = await clear(mom, baby);
      expect(del.statusCode).toBe(204);
      expect(del.body).toBe("");
      const after = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(after.threadId).toBeNull();
      expect(after.messages).toEqual([]);
      // clearing does not reset the 100 turns / 24 h limit
      expect(after.turnsLeftToday).toBe(98);
      const audit = await h.audit({ event: "chat.cleared", baby });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_user_id).toBe(mom.id);
      expect(JSON.stringify(audit)).not.toContain("photos with Grandma");
      expect(
        (
          await h.admin.query(
            "SELECT count(*)::int AS n FROM public.chat_messages WHERE baby_id = $1",
            [baby],
          )
        ).rows[0].n,
      ).toBe(0);
      // the spend ledger survives the cleared history
      expect(
        (
          await h.admin.query("SELECT count(*)::int AS n FROM public.ai_spend WHERE baby_id = $1", [
            baby,
          ])
        ).rows[0].n,
      ).toBe(2);
    });

    it("clearing when there is no thread is still a 204", async () => {
      await resetMomChat();
      expect((await clear(mom, baby)).statusCode).toBe(204);
    });

    it("one admin cannot see or clear another admin's thread", async () => {
      await resetMomChat();
      useChat();
      await post(mom, baby, "photos with Grandma");
      expect((await clear(dad, baby)).statusCode).toBe(204);
      const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(t.messages).toHaveLength(2);
    });

    it("a photo trashed after the answer drops out of the thread's photos", async () => {
      await resetMomChat();
      useChat();
      await post(mom, baby, "photos with Grandma");
      await h.admin.query("UPDATE public.photos SET deleted_at = now() WHERE id = $1", [ph.park]);
      try {
        const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
        expect(t.messages[1]?.photos.map((p) => p.id) ?? []).not.toContain(ph.park);
      } finally {
        await h.admin.query("UPDATE public.photos SET deleted_at = NULL WHERE id = $1", [ph.park]);
        // the cleanup trigger removed the search row on trash; restoring leaves it "missing" for
        // the indexer, so put the fixture row back
        await seedSearchRow(h.admin, {
          photoId: ph.park as string,
          babyId: baby,
          text: `Walking in the park with Grandma. Note from parent: "${SECRET_NOTE}"`,
          tags: ["park"],
          people: ["Grandma"],
          takenAt: "2026-07-20T12:00:00Z",
          ageDays: 141,
        });
      }
    });

    it("history is sent to the model as text, newest turn last", async () => {
      await resetMomChat();
      const seen: unknown[][] = [];
      const inner = fakeChat();
      ai.chat = {
        provider: inner.provider,
        model: inner.model,
        complete: inner.complete,
        stream(messages, tools, options) {
          seen.push(structuredClone(messages));
          return inner.stream(messages, tools, options);
        },
      };
      await post(mom, baby, "photos with Grandma");
      await post(mom, baby, "show me the bath");
      // fast path: one model call per turn, so the last call is the second turn's only call
      const secondTurnFirstCall = seen.at(-1) as { role: string; content: string }[];
      expect(secondTurnFirstCall.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
      ]);
      expect(secondTurnFirstCall.at(-1)?.content).toBe("show me the bath");
      expect(secondTurnFirstCall[1]?.content).toBe("photos with Grandma");
      // the system prompt carries the baby's name and dates, nothing from other users
      expect(secondTurnFirstCall[0]?.content).toContain("Baby's name: Plus baby");
      expect(secondTurnFirstCall[0]?.content).toContain("Birth date: 2026-03-01");
    });
  });

  describe("fast path, tool behaviour and measurement photos", () => {
    const jsonLogs = () =>
      logs.flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const spendItems = async () =>
      (
        await h.admin.query(
          "SELECT item_count FROM public.ai_spend WHERE baby_id = $1 AND kind = 'chat' ORDER BY created_at DESC LIMIT 1",
          [baby],
        )
      ).rows[0]?.item_count as number | undefined;

    /** A model that calls one tool, then answers `reply(toolContent)`; records the tool content. */
    function scripted(
      call: { name: string; arguments: unknown },
      reply: (toolContent: string) => string = () => "Done.",
    ) {
      const seen: { tool?: string; calls: number } = { calls: 0 };
      const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, costUsd: 0.0001 };
      const model: ChatModel = {
        provider: "fake",
        model: "gpt-6-luna",
        complete: async () => {
          throw new Error("unused");
        },
        async *stream(messages) {
          seen.calls++;
          const tool = messages.find((m) => m.role === "tool");
          if (tool && tool.role === "tool") {
            seen.tool = tool.content;
            const text = reply(tool.content);
            yield { type: "text_delta", delta: text };
            yield {
              type: "done",
              completion: {
                model: "gpt-6-luna",
                text,
                toolCalls: [],
                finishReason: "stop",
                usage,
                latencyMs: 1,
              },
            };
            return;
          }
          const toolCall = { id: "call_1", name: call.name, arguments: call.arguments };
          yield { type: "tool_call", toolCall };
          yield {
            type: "done",
            completion: {
              model: "gpt-6-luna",
              text: "",
              toolCalls: [toolCall],
              finishReason: "tool_calls",
              usage,
              latencyMs: 1,
            },
          };
        },
      };
      return { model, seen };
    }
    const NULLS = {
      query: null,
      date_from: null,
      date_to: null,
      age_from_days: null,
      age_to_days: null,
      milestones: [],
      people: [],
      tags: [],
      limit: null,
    };
    const resultIds = (content: string | undefined) =>
      (JSON.parse(content ?? "{}") as { results?: { photo_id: string }[] }).results?.map(
        (r) => r.photo_id,
      ) ?? [];

    it("a find-photos request takes one model call and cites exactly the search results", async () => {
      await resetMomChat();
      useChat();
      modelCalls.mockClear();
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "Photos with Grandma")).json(),
      );
      expect(modelCalls).toHaveBeenCalledTimes(1);
      expect(out.message.text).toBe("Here is 1 photo that matches.");
      expect(out.message.citations.photoIds).toEqual([ph.park]);
      expect(out.message.grounded).toBe(true);
      expect(await spendItems()).toBe(1);
      const turn = jsonLogs().find((l) => l.msg === "chat turn");
      expect(turn).toMatchObject({ fastPath: true, calls: 1, finishReason: "fast_path" });
    });

    it("a what/when/how question keeps the model-written second call", async () => {
      await resetMomChat();
      useChat();
      modelCalls.mockClear();
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "What is in the bath photo?")).json(),
      );
      expect(modelCalls).toHaveBeenCalledTimes(2);
      expect(out.message.citations.photoIds).toContain(ph.bath);
      expect(await spendItems()).toBe(2);
      expect(jsonLogs().find((l) => l.msg === "chat turn")).toMatchObject({
        fastPath: false,
        calls: 2,
      });
    });

    it("several searches in one turn get the group sentence", async () => {
      await resetMomChat();
      useChat();
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "show her at 3 and 4 months")).json(),
      );
      expect(out.message.text).toBe("Here are 2 photos for the times you asked about.");
      expect([...out.message.citations.photoIds].sort()).toEqual([ph.bath, ph.park].sort());
    });

    it("a find-photos request with no results says nothing was found, in one call", async () => {
      await resetMomChat();
      useChat();
      modelCalls.mockClear();
      const out = chatTurnResponseSchema.parse((await post(mom, baby, "photos in 2020")).json());
      expect(out.message.text).toBe(CHAT_MESSAGES.nothingFound);
      expect(out.message.photos).toEqual([]);
      expect(modelCalls).toHaveBeenCalledTimes(1);
    });

    it("search_photos relaxes once: people/tags that match nothing become query words", async () => {
      await resetMomChat();
      logs.length = 0;
      const { model, seen } = scripted({
        name: "search_photos",
        arguments: { ...NULLS, query: "bath", people: ["SentinelPerson"], tags: ["sentineltag"] },
      });
      ai.chat = model;
      expect((await post(mom, baby, "What do the photos show?")).statusCode).toBe(200);
      expect(resultIds(seen.tool)).toEqual([ph.bath]);
      // values never reach a log line
      const dump = logs.join("");
      for (const secret of ["SentinelPerson", "sentineltag"]) expect(dump).not.toContain(secret);
    });

    it("the route gives the tools a logger: one shape-only 'chat tool search_photos' line per search", async () => {
      await resetMomChat();
      logs.length = 0;
      const { model } = scripted({
        name: "search_photos",
        arguments: { ...NULLS, query: "bath", people: ["SentinelPerson"] },
      });
      ai.chat = model;
      await post(mom, baby, "What do the photos show?");
      const lines = jsonLogs().filter((l) => l.msg === "chat tool search_photos");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ tool: "search_photos", relaxed: true });
      expect(lines[0]?.set).toEqual(["query", "people[1]"]);
      expect(logs.join("")).not.toContain("SentinelPerson");
    });

    it("no relaxing when the strict search already found something", async () => {
      await resetMomChat();
      logs.length = 0;
      const { model, seen } = scripted({
        name: "search_photos",
        arguments: { ...NULLS, people: ["Grandma"] },
      });
      ai.chat = model;
      await post(mom, baby, "What do the photos show?");
      expect(resultIds(seen.tool)).toEqual([ph.park]);
    });

    it("an unknown milestone name becomes query words and is reported as unknown", async () => {
      await resetMomChat();
      logs.length = 0;
      const { model, seen } = scripted({
        name: "search_photos",
        arguments: { ...NULLS, milestones: ["Bath time"] },
      });
      ai.chat = model;
      await post(mom, baby, "What do the photos show?");
      expect(resultIds(seen.tool)).toContain(ph.bath);
      expect(JSON.parse(seen.tool ?? "{}").unknown_milestones).toEqual(["Bath time"]);
      expect(logs.join("")).not.toContain("Bath time");
    });

    it("an age window is widened by 15 days only when the search has free text", async () => {
      await resetMomChat();
      // bath photo: age 101 days; window 60..90 misses it exactly but not within 15 days
      for (const [query, expectFound] of [
        ["bath", true],
        [null, false],
      ] as const) {
        logs.length = 0;
        const { model, seen } = scripted({
          name: "search_photos",
          arguments: { ...NULLS, query, age_from_days: 60, age_to_days: 90 },
        });
        ai.chat = model;
        await post(mom, baby, "What do the photos show?");
        expect(resultIds(seen.tool).includes(ph.bath as string), String(query)).toBe(expectFound);
        const line = jsonLogs().find((l) => l.msg === "chat tool search_photos");
        expect(line).toMatchObject({ windowWidened: query !== null });
        await resetMomChat();
      }
    });

    describe("time windows with free text", () => {
      const KAYAK = "kayaksentinelq";
      let kayak: string;
      beforeAll(async () => {
        kayak = await seedPhoto(h.admin, baby, {
          uploadedBy: mom.id,
          status: "ingested",
          withThumb: true,
          takenAt: "2026-05-10T12:00:00Z",
        });
        await seedSearchRow(h.admin, {
          photoId: kayak,
          babyId: baby,
          text: `Paddling a ${KAYAK} on the lake`,
          tags: [],
          takenAt: "2026-05-10T12:00:00Z",
          ageDays: 70,
        });
      });
      afterAll(async () => {
        await h.admin.query("DELETE FROM public.photos WHERE id = $1", [kayak]);
      });

      const searchWith = async (args: Record<string, unknown>) => {
        await resetMomChat();
        const { model, seen } = scripted({
          name: "search_photos",
          arguments: { ...NULLS, ...args },
        });
        ai.chat = model;
        const res = await post(mom, baby, "What do the photos show?", sse);
        expect(res.statusCode).toBe(200);
        const line = jsonLogs().find((l) => l.msg === "chat tool search_photos");
        return { ids: resultIds(seen.tool), line, res };
      };

      it("planted: a target 3 days before the window start is found when the query has text", async () => {
        const text = await searchWith({
          query: KAYAK,
          date_from: "2026-05-13",
          date_to: "2026-05-31",
        });
        expect(text.ids).toEqual([kayak]);
        expect(text.line).toMatchObject({ windowWidened: true, windowRetry: false, lexical: 1 });
        // filter-only keeps the window exact: the same window finds nothing
        const filterOnly = await searchWith({ date_from: "2026-05-13", date_to: "2026-05-31" });
        expect(filterOnly.ids).not.toContain(kayak);
        expect(filterOnly.line).toMatchObject({ windowWidened: false, windowRetry: false });
      });

      it("the window is widened on the end side too (3 days after the end)", async () => {
        const r = await searchWith({
          query: KAYAK,
          date_from: "2026-04-01",
          date_to: "2026-05-07",
        });
        expect(r.ids).toEqual([kayak]);
        expect(r.line).toMatchObject({ windowWidened: true, windowRetry: false });
      });

      it("30 days outside: the +/-15 days miss, one +/-45 day retry finds the lexical match", async () => {
        const r = await searchWith({
          query: KAYAK,
          date_from: "2026-06-09",
          date_to: "2026-06-30",
        });
        expect(r.ids).toEqual([kayak]);
        expect(r.line).toMatchObject({
          windowWidened: true,
          windowRetry: true,
          lexical: 1,
          results: 1,
        });
        // an age window gets the same treatment (age 70; window 100..120 is 30 days away)
        const byAge = await searchWith({ query: KAYAK, age_from_days: 100, age_to_days: 120 });
        expect(byAge.ids).toEqual([kayak]);
        expect(byAge.line).toMatchObject({ windowRetry: true, ageWindow: 20 });
      });

      it("60 days outside is out of reach: no retry result is kept", async () => {
        const r = await searchWith({
          query: KAYAK,
          date_from: "2026-07-20",
          date_to: "2026-08-10",
        });
        expect(r.ids).toEqual([]);
        // the retry ran and found no lexical match; the diagnostics say the word does exist in the
        // album (1 term, 1 photo with no filter at all): the window was the problem
        expect(r.line).toMatchObject({
          windowWidened: true,
          windowRetryTried: true,
          windowRetry: false,
          retryLexical: 0,
          results: 0,
          queryTerms: 1,
          textCandidates: 1,
        });
      });

      it("a retry without a lexical match is discarded (the original result stays)", async () => {
        // "bath" matches the bath photo (June 10) lexically only inside the window; the retried
        // window would add nothing lexical for an unrelated word
        const r = await searchWith({
          query: "zzzunmatched",
          date_from: "2026-06-09",
          date_to: "2026-06-30",
        });
        expect(r.ids).toEqual([]);
        expect(r.line).toMatchObject({
          windowRetryTried: true,
          windowRetry: false,
          retryLexical: 0,
          lexical: 0,
          queryTerms: 1,
          textCandidates: 0, // the word is nowhere in the album, with or without the window
        });
      });

      it("no window, no retry: an unmatched text search is not retried", async () => {
        const r = await searchWith({ query: "zzzunmatched" });
        expect(r.line).toMatchObject({
          windowWidened: false,
          windowRetryTried: false,
          windowRetry: false,
          retryLexical: null,
          queryTerms: 1,
          textCandidates: 0,
        });
        for (const k of ["queryTerms", "textCandidates", "retryLexical"]) {
          const v = (r.line as Record<string, unknown>)[k];
          expect(v === null || Number.isInteger(v), k).toBe(true);
        }
      });

      it("filter-only searches carry no text diagnostics", async () => {
        const r = await searchWith({ date_from: "2026-05-13", date_to: "2026-05-31" });
        expect(r.line).toMatchObject({
          queryTerms: null,
          textCandidates: null,
          windowRetryTried: false,
        });
      });

      it("the SSE path logs one info line per search and a searches array on the turn: names, counts and flags only", async () => {
        const r = await searchWith({
          query: KAYAK,
          date_from: "2026-05-13",
          date_to: "2026-05-31",
          people: ["SentinelPerson"],
          milestones: ["Sentinel Milestone"],
        });
        expect(r.res.headers["content-type"]).toMatch(/text\/event-stream/);
        const lines = jsonLogs().filter((l) => l.msg === "chat tool search_photos");
        expect(lines).toHaveLength(1);
        const keys = Object.keys(lines[0] ?? {}).filter(
          (k) => !["level", "time", "pid", "hostname", "reqId", "msg", "req", "res"].includes(k),
        );
        expect(keys.sort()).toEqual(
          [
            "ageWindow",
            "candidates",
            "lexical",
            "queryTerms",
            "relaxed",
            "results",
            "retryLexical",
            "set",
            "textCandidates",
            "tool",
            "unknownMilestones",
            "windowRetry",
            "windowRetryTried",
            "windowWidened",
          ].sort(),
        );
        expect(lines[0]).toMatchObject({
          tool: "search_photos",
          ageWindow: null,
          unknownMilestones: 1,
          windowWidened: true,
          // found lexically on the first (widened) search: nothing to retry or diagnose
          windowRetryTried: false,
          retryLexical: null,
          queryTerms: null,
          textCandidates: null,
        });
        expect(lines[0]?.set).toEqual([
          "query",
          "date_from",
          "date_to",
          "milestones[1]",
          "people[1]",
        ]);
        const turn = jsonLogs().find((l) => l.msg === "chat turn");
        const searches = turn?.searches as Record<string, unknown>[];
        expect(searches).toHaveLength(1);
        expect(searches[0]).toMatchObject({
          tool: "search_photos",
          windowWidened: true,
          relaxed: expect.any(Boolean),
        });
        // sentinel words and the query never appear in any log line
        const dump = logs.join("");
        for (const secret of [KAYAK, "SentinelPerson", "Sentinel Milestone"]) {
          expect(dump, secret).not.toContain(secret);
        }
      });
    });

    it("search results carry at most 6 tags per photo", async () => {
      await resetMomChat();
      const many = await seedPhoto(h.admin, baby, {
        uploadedBy: mom.id,
        status: "ingested",
        withThumb: true,
      });
      try {
        await seedSearchRow(h.admin, {
          photoId: many,
          babyId: baby,
          text: "tagfest gathering of many labels",
          tags: Array.from({ length: 12 }, (_, i) => `label${i}`),
        });
        const { model, seen } = scripted({
          name: "search_photos",
          arguments: { ...NULLS, query: "tagfest" },
        });
        ai.chat = model;
        await post(mom, baby, "What do the photos show?");
        const results = (
          JSON.parse(seen.tool ?? "{}") as { results: { photo_id: string; tags: string[] }[] }
        ).results;
        const row = results.find((r) => r.photo_id === many);
        expect(row?.tags).toHaveLength(6);
      } finally {
        await h.admin.query("DELETE FROM public.photos WHERE id = $1", [many]);
      }
    });

    it("citing a measurement brings its linked photo into the grid and the citations, server-side", async () => {
      await resetMomChat();
      const { model } = scripted(
        {
          name: "get_measurements",
          arguments: { kind: "weight", date_from: "2026-09-01", date_to: "2026-09-01" },
        },
        (tool) => {
          const id = (JSON.parse(tool) as { measurements: { measurement_id: string }[] })
            .measurements[0]?.measurement_id;
          return `She weighed 7.2 kg. [measurement:${id}]`;
        },
      );
      ai.chat = model;
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "What did she weigh?")).json(),
      );
      expect(out.message.citations.measurementIds).toEqual([measurementId]);
      // the model never cited the photo
      expect(out.message.citations.photoIds).toEqual([ph.weigh]);
      expect(out.message.photos.map((p) => p.id)).toEqual([ph.weigh]);
      expect(out.message.grounded).toBe(true);
      const row = (
        await h.admin.query(
          "SELECT cited_photo_ids FROM public.chat_messages WHERE role = 'assistant' AND baby_id = $1",
          [baby],
        )
      ).rows[0];
      expect(row.cited_photo_ids).toEqual([ph.weigh]);
    });

    it("a cited measurement without a linked photo adds no photo", async () => {
      await resetMomChat();
      const { model } = scripted(
        {
          name: "get_measurements",
          arguments: { kind: "weight", date_from: "2026-07-01", date_to: "2026-07-01" },
        },
        (tool) => {
          const id = (JSON.parse(tool) as { measurements: { measurement_id: string }[] })
            .measurements[0]?.measurement_id;
          return `[measurement:${id}]`;
        },
      );
      ai.chat = model;
      const out = chatTurnResponseSchema.parse(
        (await post(mom, baby, "What did she weigh?")).json(),
      );
      expect(out.message.citations.measurementIds).toHaveLength(1);
      expect(out.message.citations.photoIds).toEqual([]);
      expect(out.message.photos).toEqual([]);
    });
  });

  describe("limits", () => {
    it("the 101st turn in 24 hours is a 429 rate_limited with Retry-After, and no model call", async () => {
      await resetMomChat();
      useChat();
      await h.admin.query(
        `INSERT INTO public.chat_turns (user_id, reserved_xid, claimed_at, created_at)
         SELECT $1, pg_current_xact_id(), now() - interval '2 hours', now() - interval '2 hours' FROM generate_series(1, 100)`,
        [mom.id],
      );
      modelCalls.mockClear();
      const res = await post(mom, baby, "one more");
      expect(res.statusCode).toBe(429);
      expect(apiErrorSchema.parse(res.json()).error).toBe("rate_limited");
      expect(res.json().message).toBe(CHAT_MESSAGES.rateLimited);
      const retry = Number(res.headers["retry-after"]);
      expect(retry).toBeGreaterThan(21.5 * 3600);
      expect(retry).toBeLessThanOrEqual(22 * 3600);
      expect(modelCalls).not.toHaveBeenCalled();
      // nothing was stored for the refused turn
      expect(
        (
          await h.admin.query(
            "SELECT count(*)::int AS n FROM public.chat_messages WHERE baby_id = $1",
            [baby],
          )
        ).rows[0].n,
      ).toBe(0);
      const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(t.turnsLeftToday).toBe(0);
      // the limit is per user: dad is unaffected
      expect((await post(dad, baby, "show me the bath")).statusCode).toBe(200);
    });

    it("the 100th turn is allowed", async () => {
      await resetMomChat();
      useChat();
      await h.admin.query(
        `INSERT INTO public.chat_turns (user_id, reserved_xid, claimed_at, created_at)
         SELECT $1, pg_current_xact_id(), now(), now() FROM generate_series(1, 99)`,
        [mom.id],
      );
      expect((await post(mom, baby, "show me the bath")).statusCode).toBe(200);
      expect((await post(mom, baby, "show me the bath")).statusCode).toBe(429);
    });

    it("a second turn while the first is still being written is a 409 conflict", async () => {
      await resetMomChat();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      useChat(undefined, gate);
      const first = post(mom, baby, "photos with Grandma");
      // wait until the first turn stored its user message
      for (let i = 0; i < 100; i++) {
        const n = (
          await h.admin.query(
            "SELECT count(*)::int AS n FROM public.chat_messages WHERE baby_id = $1",
            [baby],
          )
        ).rows[0].n;
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const second = await post(mom, baby, "another question");
      expect(second.statusCode).toBe(409);
      expect(apiErrorSchema.parse(second.json()).error).toBe("conflict");
      expect(second.json().message).toBe(CHAT_MESSAGES.busy);
      release();
      expect((await first).statusCode).toBe(200);
      // afterwards the thread is free again
      useChat();
      expect((await post(mom, baby, "show me the bath")).statusCode).toBe(200);
      // the refused request stored nothing and cost no turn: 2 completed turns
      const t = chatThreadResponseSchema.parse((await thread(mom, baby)).json());
      expect(t.turnsLeftToday).toBe(98);
      expect(t.messages).toHaveLength(4);
    });

    it("a stale unanswered user message (crashed turn) stops blocking after the busy window", async () => {
      await resetMomChat();
      useChat();
      await post(mom, baby, "photos with Grandma");
      // simulate a crash: the last message is a user message from long ago
      await h.admin.query(
        "DELETE FROM public.chat_messages WHERE role = 'assistant' AND baby_id = $1",
        [baby],
      );
      await h.admin.query(
        "UPDATE public.chat_messages SET created_at = now() - interval '1 hour' WHERE baby_id = $1",
        [baby],
      );
      expect((await post(mom, baby, "show me the bath")).statusCode).toBe(200);
    });
  });

  describe("budget", () => {
    it("a spent monthly budget is a 429 ai_budget_exceeded with Retry-After to the next UTC month, audited once", async () => {
      const h2 = await createHarness({ ai, config: { AI_BABY_MONTHLY_BUDGET_USD: 0.0001 } });
      try {
        const u = await h2.user();
        const b = await h2.baby(u, "Budget baby");
        await h2.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [b]);
        useChat();
        modelCalls.mockClear();
        let last: Awaited<ReturnType<typeof h2.inject>> | undefined;
        for (let i = 0; i < 3; i++) {
          last = await h2.inject(
            u,
            "POST",
            `/babies/${b}/chat/messages`,
            { text: "show me the bath" },
            accept,
          );
          expect(last.statusCode).toBe(429);
          expect(apiErrorSchema.parse(last.json()).error).toBe("ai_budget_exceeded");
        }
        const retry = Number(last?.headers["retry-after"]);
        const now = new Date();
        const toMonthEnd =
          (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000;
        expect(retry).toBeGreaterThan(toMonthEnd - 5);
        expect(retry).toBeLessThanOrEqual(Math.ceil(toMonthEnd) + 1);
        expect(modelCalls).not.toHaveBeenCalled();
        // one audit row for the month, however many refusals
        const audit = await h2.audit({ event: "ai.budget_exceeded", baby: b });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.metadata).toMatchObject({
          month: now.toISOString().slice(0, 7),
          kind: "chat",
        });
        expect(audit[0]?.actor_user_id).toBe(u.id);
        // nothing stored, nothing spent, no turn consumed
        expect(
          (
            await h2.admin.query(
              "SELECT count(*)::int AS n FROM public.chat_messages WHERE baby_id = $1",
              [b],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await h2.admin.query(
              "SELECT count(*)::int AS n FROM public.ai_spend WHERE baby_id = $1",
              [b],
            )
          ).rows[0].n,
        ).toBe(0);
        const t = chatThreadResponseSchema.parse(
          (await h2.inject(u, "GET", `/babies/${b}/chat/thread`)).json(),
        );
        expect(t.turnsLeftToday).toBe(100);
      } finally {
        await h2.close();
      }
    });

    it("spend recorded by earlier turns counts toward the budget (embeddings and chat, not only vision)", async () => {
      const h3 = await createHarness({ ai, config: { AI_BABY_MONTHLY_BUDGET_USD: 0.5 } });
      try {
        const u = await h3.user();
        const b = await h3.baby(u, "Spent baby");
        await h3.admin.query("UPDATE public.babies SET plan = 'plus' WHERE id = $1", [b]);
        useChat();
        expect(
          (await h3.inject(u, "POST", `/babies/${b}/chat/messages`, { text: "hello" }, accept))
            .statusCode,
        ).toBe(200);
        await h3.admin.query(
          "INSERT INTO public.ai_spend (baby_id, kind, model, cost_usd) VALUES ($1, 'embed', 'fake', 0.4995)",
          [b],
        );
        const res = await h3.inject(
          u,
          "POST",
          `/babies/${b}/chat/messages`,
          { text: "hello again" },
          accept,
        );
        expect(res.statusCode).toBe(429);
        expect(res.json().error).toBe("ai_budget_exceeded");
      } finally {
        await h3.close();
      }
    });
  });

  describe("privacy of logs and responses", () => {
    it("the question, the answer and the note never reach a log line; no document, GPS or raw JSON in responses", async () => {
      await resetMomChat();
      useChat();
      logs.length = 0;
      const jsonRes = await post(mom, baby, `${QUESTION_SENTINEL} photos with Grandma`);
      const sseRes = await post(
        mom,
        baby,
        `${QUESTION_SENTINEL} tell me about photo ${ph.park}`,
        sse,
      );
      const threadRes = await thread(mom, baby);
      const dump = logs.join("");
      expect(dump.length).toBeGreaterThan(0);
      expect(dump).not.toContain(QUESTION_SENTINEL);
      expect(dump).not.toContain(SECRET_NOTE);
      expect(dump).not.toContain("Here are");
      for (const body of [jsonRes.body, sseRes.body, threadRes.body]) {
        for (const word of [
          "search_text",
          "latitude",
          "longitude",
          "raw_json",
          "storage_key",
          "embedding",
        ]) {
          expect(body.toLowerCase(), word).not.toContain(word);
        }
      }
      // the note reaches only the model through get_photo, never the response (the fake quotes captions)
      expect(jsonRes.body).not.toContain(SECRET_NOTE);
      expect(threadRes.body).not.toContain(SECRET_NOTE);
      // logs carry counts and ids of the turn
      expect(dump).toContain('"msg":"chat turn"');
    });
  });
});
