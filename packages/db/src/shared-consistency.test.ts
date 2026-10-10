import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// packages/db must not depend on @tinyglow/shared at runtime: relative import, test only.
import { DEMO_IDS, MILESTONE_PRESETS } from "../../shared/src/constants";
import { DEMO } from "./seed";

// Pure (no database) consistency between @tinyglow/shared and the db package, so drift fails
// `pnpm test` as well as the integration suite.

describe("@tinyglow/shared DEMO_IDS match the seed's DEMO", () => {
  it("users, baby and share link", () => {
    expect(DEMO_IDS.users).toEqual(DEMO.users);
    expect(DEMO_IDS.baby).toBe(DEMO.baby);
    expect(DEMO_IDS.shareLink).toBe(DEMO.shareLink);
  });

  it("the 12 photo ids, in order", () => {
    expect(DEMO_IDS.photos).toHaveLength(12);
    expect([...DEMO_IDS.photos]).toEqual(Array.from({ length: 12 }, (_, i) => DEMO.photo(i + 1)));
    expect(new Set(DEMO_IDS.photos).size).toBe(12);
  });
});

describe("MILESTONE_PRESETS", () => {
  it("has 12 unique ids 10000000-0000-4000-8000-0000000000NN, sortOrder = NN x 10, matching DEMO.milestonePreset", () => {
    expect(MILESTONE_PRESETS).toHaveLength(12);
    expect(new Set(MILESTONE_PRESETS.map((p) => p.id)).size).toBe(12);
    MILESTONE_PRESETS.forEach((p, i) => {
      const nn = i + 1;
      expect(p.id).toBe(DEMO.milestonePreset(nn));
      expect(p.id).toBe(`10000000-0000-4000-8000-0000000000${String(nn).padStart(2, "0")}`);
      expect(p.sortOrder).toBe(nn * 10);
    });
  });

  it("every preset appears verbatim in the photos migration (id, name, category, sort order)", () => {
    const sql = readFileSync(
      new URL("../migrations/1791520000300_photos.sql", import.meta.url),
      "utf8",
    );
    const up = sql.split("-- Down Migration")[0] ?? "";
    for (const p of MILESTONE_PRESETS) {
      const escaped = p.name.replace(/'/g, "''");
      const re = new RegExp(
        `'${p.id}'\\s*,\\s*NULL\\s*,\\s*'${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\s*,\\s*'${p.category}'\\s*,\\s*${p.sortOrder}\\b`,
      );
      expect(up, `${p.id} ${p.name}`).toMatch(re);
    }
  });
});
