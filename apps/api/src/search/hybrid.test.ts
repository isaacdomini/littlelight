import type { Embedder } from "@littlelight/ai";
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../auth";
import {
  candidateCall,
  defaultFastPathMinSimilarity,
  defaultMinSimilarity,
  embedQuery,
  exactVectorSql,
  filterSql,
  type HybridInput,
  hnswVectorSql,
  hybridSearch,
  queryTokens,
  setHnswLocals,
  vectorLiteral,
} from "./hybrid";

const BABY = "11111111-1111-4111-8111-111111111111";
const MS = "22222222-2222-4222-8222-222222222222";

const base = (over: Partial<HybridInput> = {}): HybridInput => ({
  babyId: BABY,
  query: null,
  dateFrom: null,
  dateTo: null,
  ageFromDays: null,
  ageToDays: null,
  milestoneIds: [],
  people: [],
  tags: [],
  place: null,
  limit: 24,
  timezone: "America/New_York",
  ...over,
});

describe("filterSql", () => {
  it("always scopes to the baby and to live approved unquarantined photos", () => {
    const { where, values } = filterSql(base());
    expect(values).toEqual([BABY]);
    expect(where).toBe(
      "s.baby_id = $1 AND p.deleted_at IS NULL AND p.approval = 'approved' AND p.quarantined_at IS NULL",
    );
  });

  it("dates become half-open instants in the caller's zone, bound as parameters", () => {
    const { where, values } = filterSql(base({ dateFrom: "2026-06-01", dateTo: "2026-06-30" }));
    expect(values).toEqual([BABY, "America/New_York", "2026-06-01", "2026-06-30"]);
    expect(where).toContain("s.taken_at >= ($3::date::timestamp AT TIME ZONE $2)");
    expect(where).toContain("s.taken_at < (($4::date + 1)::timestamp AT TIME ZONE $2)");
  });

  it("only the given side of a date range is applied", () => {
    const from = filterSql(base({ dateFrom: "2026-06-01" }));
    expect(from.where).toContain("s.taken_at >=");
    expect(from.where).not.toContain("s.taken_at <");
    const to = filterSql(base({ dateTo: "2026-06-30" }));
    expect(to.where).toContain("s.taken_at <");
    expect(to.where).not.toContain("s.taken_at >=");
  });

  it("age bounds are inclusive; zero is a real bound", () => {
    const { where, values } = filterSql(base({ ageFromDays: 0, ageToDays: 30 }));
    expect(where).toContain("s.age_days >= $2::int");
    expect(where).toContain("s.age_days <= $3::int");
    expect(values).toEqual([BABY, 0, 30]);
  });

  it("milestones, people (lower-cased), tags (lower-cased) and place", () => {
    const { where, values } = filterSql(
      base({ milestoneIds: [MS], people: ["Grandma", "Dad"], tags: ["BATH"], place: "Home" }),
    );
    expect(where).toContain("s.milestone_ids && $2::uuid[]");
    expect(where).toContain("lower(x) = ANY($3::text[])");
    expect(where).toContain("s.tags && $4::text[]");
    expect(where).toContain("s.place = lower($5)");
    expect(values).toEqual([BABY, [MS], ["grandma", "dad"], ["bath"], "Home"]);
  });

  it("values never appear inside the SQL text (no injection through filters)", () => {
    const evil = "x'; DROP TABLE photos; --";
    const { where, values } = filterSql(base({ people: [evil], tags: [evil], place: evil }));
    expect(where).not.toContain("DROP");
    expect(JSON.stringify(values)).toContain("DROP");
  });
});

describe("queryTokens", () => {
  it("lower-cases, splits on punctuation, drops 1-letter words and adds adjacent pairs", () => {
    expect(queryTokens("Aunt Lily at the Beach!")).toEqual([
      "aunt",
      "lily",
      "at",
      "the",
      "beach",
      "aunt lily",
      "lily at",
      "at the",
      "the beach",
    ]);
  });

  it("keeps apostrophes and hyphens inside words and trims them at the edges", () => {
    expect(queryTokens("Mom's  'first' step-by-step")).toEqual([
      "mom's",
      "first",
      "step-by-step",
      "mom's first",
      "first step-by-step",
    ]);
  });

  it("handles unicode, empty and single-character input; caps at 40", () => {
    expect(queryTokens("")).toEqual([]);
    expect(queryTokens("a b c")).toEqual([]);
    expect(queryTokens("Zoë Müller")).toEqual(["zoë", "müller", "zoë müller"]);
    expect(queryTokens(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ")).length).toBe(40);
  });
});

describe("vectorLiteral and the vector SQL", () => {
  it("renders pgvector text input and zeroes non-finite numbers", () => {
    expect(vectorLiteral([0.5, -1, 2])).toBe("[0.5,-1,2]");
    expect(vectorLiteral([Number.NaN, Number.POSITIVE_INFINITY, 1])).toBe("[0,0,1]");
    expect(vectorLiteral([])).toBe("[]");
  });

  it("the exact path filters first behind a MATERIALIZED fence and skips unembedded rows", () => {
    const sql = exactVectorSql("s.baby_id = $1", "$2", 50);
    expect(sql).toContain("AS MATERIALIZED");
    expect(sql).toContain("s.embedding IS NOT NULL");
    expect(sql).toContain("ORDER BY d LIMIT 50");
    expect(sql).toContain("$2::vector");
  });

  it("the HNSW path orders by the distance operator with a LIMIT (what the index needs)", () => {
    const sql = hnswVectorSql("s.baby_id = $1", "$2", 50);
    expect(sql).toMatch(/ORDER BY s\.embedding <=> \$2::vector LIMIT 50/);
    expect(sql).not.toContain("MATERIALIZED");
  });

  it("setHnswLocals sets the knobs transaction-locally", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await setHnswLocals({ query } as unknown as Tx, 120.7);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, string[]];
    expect(sql).toContain("set_config('hnsw.ef_search', $1, true)");
    expect(sql).toContain("hnsw.iterative_scan");
    expect(params).toEqual(["120"]);
  });
});

describe("candidateCall", () => {
  it("the text leg ORs the lexemes of plainto_tsquery and passes the 11 function arguments + zone", () => {
    const c = candidateCall(
      "text",
      base({
        query: "bath duck",
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        ageFromDays: 1,
        ageToDays: 2,
        milestoneIds: [MS],
        people: ["Dad"],
        tags: ["Bath"],
        place: "home",
      }),
      50,
    );
    expect(c.text).toContain("public.photo_search_text_candidates(");
    expect(c.text).toContain(
      "replace(plainto_tsquery('english', $2::text)::text, ' & ', ' | ')::tsquery",
    );
    expect(c.values).toEqual([
      BABY,
      "bath duck",
      50,
      "2026-06-01",
      "2026-06-30",
      1,
      2,
      [MS],
      ["dad"],
      ["bath"],
      "home",
      "America/New_York",
    ]);
  });

  it("the term leg gets tokens (words and pairs); empty filters become null", () => {
    const c = candidateCall("term", base({ query: "Aunt Lily" }), 20);
    expect(c.text).toContain("public.photo_search_term_candidates(");
    expect(c.values[1]).toEqual(["aunt", "lily", "aunt lily"]);
    expect(c.values[2]).toBe(20);
    expect(c.values.slice(3, 11)).toEqual([null, null, null, null, null, null, null, null]);
  });

  it("dates use the half-open instant conversion with the zone as $12", () => {
    const c = candidateCall("text", base({ query: "x" }), 5);
    expect(c.text).toContain("($5::date + 1)::timestamp AT TIME ZONE $12::text");
    expect(c.values).toHaveLength(12);
  });
});

// A scripted client that answers by SQL fragment.
function scripted(opts: {
  candidates: number;
  embedded: number;
  vectorRows?: { photo_id: string; d: number }[];
}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes("count(*)::int AS n")) {
        return { rows: [{ n: opts.candidates, embedded: opts.embedded }] };
      }
      if (sql.includes("photo_search_text_candidates"))
        return { rows: [{ photo_id: "t1" }, { photo_id: "both" }] };
      if (sql.includes("photo_search_term_candidates")) return { rows: [{ photo_id: "both" }] };
      if (sql.includes("MATERIALIZED") || sql.includes("<=>")) {
        return {
          rows: opts.vectorRows ?? [
            { photo_id: "v1", d: 0.1 },
            { photo_id: "both", d: 0.1 },
          ],
        };
      }
      if (sql.includes("SELECT s.photo_id, s.taken_at AS t")) {
        return { rows: [{ photo_id: "both", t: new Date(5) }] };
      }
      if (sql.includes("ORDER BY s.taken_at DESC"))
        return { rows: [{ photo_id: "f1" }, { photo_id: "f2" }, { photo_id: "f3" }] };
      return { rows: [] };
    }),
  };
  return { client: client as unknown as Tx, calls, raw: client };
}

function embedder(): Embedder & { embed: ReturnType<typeof vi.fn> } {
  return {
    model: "fake",
    dims: 1024,
    embed: vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => [0.1, 0.2]),
      usage: { inputTokens: 1, costUsd: 0 },
    })),
  } as never;
}

describe("hybridSearch", () => {
  it("makes no embedding call and runs no leg when there are no candidates", async () => {
    const { client, calls } = scripted({ candidates: 0, embedded: 0 });
    const e = embedder();
    const r = await hybridSearch(client, base({ query: "bath" }), {
      embedder: e,
      exactMax: 2000,
      efSearch: 100,
    });
    expect(r).toMatchObject({ ids: [], candidates: 0, path: "empty", degraded: null });
    expect(e.embed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("filters only (query null): newest first, no embedding call, no leg", async () => {
    const { client, calls } = scripted({ candidates: 3, embedded: 3 });
    const e = embedder();
    const r = await hybridSearch(client, base({ limit: 2 }), {
      embedder: e,
      exactMax: 2000,
      efSearch: 100,
    });
    expect(r.path).toBe("filters");
    expect(r.ids).toEqual(["f1", "f2"]);
    expect(r.truncated).toBe(true);
    expect(e.embed).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("photo_search_text_candidates"))).toBe(false);
    // whitespace-only counts as no query
    const r2 = await hybridSearch(client, base({ query: "   " }), {
      embedder: e,
      exactMax: 2000,
      efSearch: 100,
    });
    expect(r2.path).toBe("filters");
  });

  it("small candidate sets use the exact path; large ones use HNSW with the knobs set", async () => {
    const small = scripted({ candidates: 10, embedded: 10 });
    const e = embedder();
    const r = await hybridSearch(small.client, base({ query: "bath" }), {
      embedder: e,
      exactMax: 2000,
      efSearch: 100,
    });
    expect(r.path).toBe("exact");
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(e.embed).toHaveBeenCalledWith(["bath"]);
    expect(small.calls.some((c) => c.sql.includes("MATERIALIZED"))).toBe(true);
    expect(small.calls.some((c) => c.sql.includes("hnsw.ef_search"))).toBe(false);

    const big = scripted({ candidates: 2001, embedded: 2001 });
    const e2 = embedder();
    const r2 = await hybridSearch(big.client, base({ query: "bath" }), {
      embedder: e2,
      exactMax: 2000,
      efSearch: 150,
    });
    expect(r2.path).toBe("hnsw");
    expect(big.calls.some((c) => c.sql.includes("hnsw.ef_search"))).toBe(true);
    expect(big.calls.some((c) => c.sql.includes("MATERIALIZED"))).toBe(false);
    // the count query is capped at exactMax + 1
    expect(big.calls[0]?.params?.at(-1)).toBe(2001);
  });

  it("the boundary: exactly exactMax candidates is still exact", async () => {
    const { client } = scripted({ candidates: 2000, embedded: 2000 });
    const r = await hybridSearch(client, base({ query: "bath" }), {
      embedder: embedder(),
      exactMax: 2000,
      efSearch: 100,
    });
    expect(r.path).toBe("exact");
  });

  it("fuses the legs with RRF: an id in several legs wins; limit and truncated apply", async () => {
    const { client } = scripted({ candidates: 10, embedded: 10 });
    const r = await hybridSearch(client, base({ query: "bath", limit: 2 }), {
      embedder: embedder(),
      exactMax: 2000,
      efSearch: 100,
    });
    expect(r.ids[0]).toBe("both");
    expect(r.ids).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.degraded).toBeNull();
  });

  describe("relevance floor (SEARCH_MIN_SIMILARITY)", () => {
    const rows = [
      { photo_id: "near", d: 0.2 }, // similarity 0.8
      { photo_id: "noise", d: 0.9 }, // similarity 0.1
      { photo_id: "both", d: 0.95 }, // similarity 0.05 but also a lexical hit
    ];
    const run = (minSimilarity: number | undefined, model = "fake") => {
      const { client } = scripted({ candidates: 10, embedded: 10, vectorRows: rows });
      const e = { ...embedder(), model } as Embedder;
      return hybridSearch(client, base({ query: "bath", limit: 24 }), {
        embedder: e,
        exactMax: 2000,
        efSearch: 100,
        ...(minSimilarity === undefined ? {} : { minSimilarity }),
      });
    };

    it("drops vector-only candidates below the floor, keeps lexical hits whatever their similarity", async () => {
      const r = await run(0.6);
      expect(r.ids).toContain("near");
      expect(r.ids).toContain("both");
      expect(r.ids).not.toContain("noise");
    });

    it("minSimilarity 0 keeps every vector candidate (pure RRF)", async () => {
      expect((await run(0)).ids).toContain("noise");
    });

    it("the default floor is 0.6 for the fake model and 0.3 for a real one", async () => {
      expect((await run(undefined, "fake")).ids).not.toContain("noise");
      const real = await run(undefined, "text-embedding-3-small");
      expect(real.ids).not.toContain("noise"); // 0.1 < 0.3
      expect(real.ids).toContain("near");
      expect(defaultMinSimilarity("fake")).toBe(0.6);
      expect(defaultMinSimilarity("text-embedding-3-small")).toBe(0.3);
      expect(defaultMinSimilarity(null)).toBe(0.3);
    });

    it("a floor above every similarity leaves only the lexical hits; none at all gives an empty result", async () => {
      const r = await run(0.99);
      expect(r.ids.sort()).toEqual(["both", "t1"]);
    });

    it("filter-only queries are not affected", async () => {
      const { client } = scripted({ candidates: 3, embedded: 3 });
      const r = await hybridSearch(client, base(), {
        embedder: embedder(),
        exactMax: 2000,
        efSearch: 100,
        minSimilarity: 0.99,
      });
      expect(r.ids).toEqual(["f1", "f2", "f3"]);
    });
  });

  it("no embedder or no vectors: degraded no_embeddings, text and tag legs still run, no embed call", async () => {
    const a = scripted({ candidates: 10, embedded: 10 });
    const noEmbedder = await hybridSearch(a.client, base({ query: "bath" }), {
      embedder: null,
      exactMax: 2000,
      efSearch: 100,
    });
    expect(noEmbedder.degraded).toBe("no_embeddings");
    expect(noEmbedder.path).toBe("text");
    expect(noEmbedder.ids).toEqual(expect.arrayContaining(["t1", "both"]));
    expect(a.calls.some((c) => c.sql.includes("MATERIALIZED") || c.sql.includes("<=>"))).toBe(
      false,
    );

    const b = scripted({ candidates: 10, embedded: 0 });
    const e = embedder();
    const noVectors = await hybridSearch(b.client, base({ query: "bath" }), {
      embedder: e,
      exactMax: 2000,
      efSearch: 100,
    });
    expect(noVectors.degraded).toBe("no_embeddings");
    expect(e.embed).not.toHaveBeenCalled();
  });

  it("never selects search_text", async () => {
    const { client, calls } = scripted({ candidates: 10, embedded: 10 });
    await hybridSearch(client, base({ query: "bath" }), {
      embedder: embedder(),
      exactMax: 2000,
      efSearch: 100,
    });
    for (const c of calls) expect(c.sql, c.sql).not.toMatch(/(?<![a-z_])search_text(?![a-z_])/);
  });

  it("an embedding failure propagates (the route maps it), after the candidate count", async () => {
    const { client } = scripted({ candidates: 10, embedded: 10 });
    const e = embedder();
    e.embed.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      hybridSearch(client, base({ query: "bath" }), { embedder: e, exactMax: 2000, efSearch: 100 }),
    ).rejects.toThrow("provider down");
  });
});

describe("query embedding cache (embedQuery)", () => {
  const counting = () => {
    const calls: string[] = [];
    const e = {
      model: "fake",
      dims: 4,
      embed: async (texts: string[]) => {
        calls.push(...texts);
        return {
          vectors: texts.map((t) => [t.length, 1, 0, 0]),
          usage: { inputTokens: 1, costUsd: 0 },
        };
      },
    } as Embedder;
    return { e, calls };
  };

  it("a repeated query is embedded once and returns the same vector", async () => {
    const { e, calls } = counting();
    const a = await embedQuery(e, "bath time");
    const b = await embedQuery(e, "bath time");
    expect(calls).toEqual(["bath time"]);
    expect(b).toBe(a);
    await embedQuery(e, "park");
    expect(calls).toEqual(["bath time", "park"]);
  });

  it("the cache is per embedder instance (a different model never sees another's vectors)", async () => {
    const one = counting();
    const two = counting();
    await embedQuery(one.e, "bath");
    await embedQuery(two.e, "bath");
    expect(one.calls).toEqual(["bath"]);
    expect(two.calls).toEqual(["bath"]);
  });

  it("is an LRU of 500: the least recently used query is evicted, a touched one survives", async () => {
    const { e, calls } = counting();
    await embedQuery(e, "q0");
    for (let i = 1; i < 500; i++) await embedQuery(e, `q${i}`);
    await embedQuery(e, "q0"); // refresh the oldest: now q1 is the least recent
    await embedQuery(e, "q500"); // 501st distinct: evicts q1
    const before = calls.length;
    await embedQuery(e, "q0");
    expect(calls.length).toBe(before); // survived
    await embedQuery(e, "q1");
    expect(calls.length).toBe(before + 1); // evicted, embedded again
  });

  it("hybridSearch embeds a repeated query once across two searches", async () => {
    const { e, calls } = counting();
    for (let i = 0; i < 2; i++) {
      const { client } = scripted({ candidates: 10, embedded: 10 });
      await hybridSearch(client, base({ query: "cached bath" }), {
        embedder: e,
        exactMax: 2000,
        efSearch: 100,
      });
    }
    expect(calls).toEqual(["cached bath"]);
  });

  it("an embedding failure is not cached", async () => {
    let n = 0;
    const flaky = {
      model: "fake",
      dims: 2,
      embed: async (texts: string[]) => {
        if (n++ === 0) throw new Error("down");
        return { vectors: texts.map(() => [1, 0]), usage: { inputTokens: 1, costUsd: 0 } };
      },
    } as Embedder;
    await expect(embedQuery(flaky, "x")).rejects.toThrow("down");
    expect(await embedQuery(flaky, "x")).toEqual([1, 0]);
  });
});

describe("defaultFastPathMinSimilarity", () => {
  it("0.38 for a real embedding model, 0.60 for the fake, 0.38 when unknown", () => {
    expect(defaultFastPathMinSimilarity("text-embedding-3-small")).toBe(0.38);
    expect(defaultFastPathMinSimilarity("fake")).toBe(0.6);
    expect(defaultFastPathMinSimilarity(null)).toBe(0.38);
    expect(defaultFastPathMinSimilarity(undefined)).toBe(0.38);
  });

  it("the fast-path floor sits above the search relevance floor of the same model", () => {
    for (const m of ["text-embedding-3-small", "fake"]) {
      expect(defaultFastPathMinSimilarity(m)).toBeGreaterThanOrEqual(defaultMinSimilarity(m));
    }
  });
});
