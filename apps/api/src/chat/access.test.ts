import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../auth";
import { ApiError } from "../lib/errors";
import { requireChatHistoryAccess } from "./access";

const BABY = "11111111-1111-4111-8111-111111111111";
const UID = "33333333-3333-4333-8333-333333333333";

function tx(rows: { role: string }[]) {
  const query = vi.fn(async () => ({ rows }));
  return { client: { query } as unknown as Tx, query };
}

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal");
};

describe("requireChatHistoryAccess (admin membership only; no plan, no model client)", () => {
  it("lets an admin through, whatever the plan", async () => {
    const { client, query } = tx([{ role: "admin" }]);
    await expect(requireChatHistoryAccess(client, UID, BABY)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = (query.mock.calls[0] as unknown as [string])[0];
    expect(sql).not.toMatch(/plan|ai_enabled|baby_ai_enabled|entitle/i);
  });

  it("answers a stranger with 404, indistinguishable from a missing album", async () => {
    const { client } = tx([]);
    const err = await refused(requireChatHistoryAccess(client, UID, BABY));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });

  it("answers a contributor with 403 forbidden (not plan_required)", async () => {
    const { client } = tx([{ role: "contributor" }]);
    const err = await refused(requireChatHistoryAccess(client, UID, BABY));
    expect(err).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("binds the caller and album as parameters", async () => {
    const { client, query } = tx([{ role: "admin" }]);
    await requireChatHistoryAccess(client, UID, BABY);
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([UID, BABY]);
  });
});
