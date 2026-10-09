import { describe, expect, it } from "vitest";
import { ApiError, mapPgError, type PgErrorLike, planRequired, toApiError } from "./errors";

const pg = (code: string, message: string, extra: Partial<PgErrorLike> = {}): PgErrorLike => ({
  code,
  message,
  severity: "ERROR",
  ...extra,
});

describe("mapPgError: step 7 messages", () => {
  it("the photo_search guard -> 409 conflict with the generic message", () => {
    const e = mapPgError(
      pg("23514", "search rows can only be stored for approved live photos of a paid-tier baby"),
    );
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toBe("That conflicts with the current state");
  });

  it("the ai_spend guard (plan lapsed during a turn) -> 403 plan_required", () => {
    const e = mapPgError(pg("23514", "AI spend can only be recorded for a paid-tier baby"));
    expect(e).toMatchObject({ status: 403, code: "plan_required" });
    expect(e.message).toBe("AI search and chat are part of Plus");
    expect(planRequired()).toMatchObject({ status: 403, code: "plan_required" });
  });

  it("a user message of the wrong length -> 400 validation_failed on body.text", () => {
    const e = mapPgError(pg("23514", "chat_messages.content must be 1 to 8000 characters"));
    expect(e).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { fields: ["body.text"] },
    });
  });

  it("server-built arrays and a bad limit are the server's fault -> 500 internal (not a 400)", () => {
    for (const m of [
      "chat_messages.cited_photo_ids holds more than 50 ids",
      "chat_messages.cited_measurement_ids holds more than 50 ids",
      "chat_messages.tools_used holds more than 16 entries",
      "chat_reserve_turn expects a positive limit",
    ]) {
      expect(mapPgError(pg("23514", m)), m).toMatchObject({ status: 500, code: "internal" });
    }
  });

  it("an unknown tool name in tools_used is not mapped to a user error", () => {
    const e = mapPgError(
      pg("23514", "chat_messages.tools_used holds a name that is not a chat tool"),
    );
    expect(e.status).not.toBe(200);
    expect(e.code).not.toBe("plan_required");
  });

  it("the turn-reservation refusal never reads as a user input error (500, no message echo)", () => {
    const e = mapPgError(
      pg(
        "23514",
        "a user chat message needs a turn reserved with chat_reserve_turn in the same transaction",
      ),
    );
    expect(e.status).toBe(500);
    expect(e.message).not.toContain("chat_reserve_turn");
  });

  it("the unique thread index is a 409 conflict; chat_reserve_turn without claims is 403", () => {
    expect(
      mapPgError(pg("23505", "duplicate key", { constraint: "chat_threads_baby_id_user_id_key" })),
    ).toMatchObject({ status: 409, code: "conflict" });
    expect(
      mapPgError(pg("42501", "chat_reserve_turn requires authenticated claims")),
    ).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("never echoes the offending SQL text, message text or column", () => {
    const e = toApiError(
      pg("23514", "chat_messages.content must be 1 to 8000 characters", {
        table: "chat_messages",
        column: "content",
      }),
    );
    expect(e).toBeInstanceOf(ApiError);
    const dump = JSON.stringify({ message: e.message, details: e.details });
    expect(dump).not.toContain("chat_messages");
    expect(dump).not.toContain("8000");
  });
});
