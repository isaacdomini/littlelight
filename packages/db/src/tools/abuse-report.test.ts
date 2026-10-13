import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type AbuseReport,
  collectReport,
  DEFAULT_DAYS,
  DEFAULT_LIMIT,
  formatBytes,
  MAX_DAYS,
  MAX_LIMIT,
  main,
  PERSONAL_DATA_WARNING,
  parseReportArgs,
  pendingWatchFrom,
  renderText,
  TEXT_ROWS_MAX,
  UsageError,
} from "./abuse-report";

// Operator report, per family (docs/plans/step-11.md 2.7, D-K; task 11.8b). Unit level: argument
// parsing, rendering and the JSON shape with a scripted client; the SQL itself runs against a
// real database in the abuse gate (e2e/abuse/gate.ts, step 6) and the integration suites.

const FAMILY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BABY = "33333333-3333-4333-8333-333333333333";

describe("parseReportArgs", () => {
  it("defaults", () => {
    expect(parseReportArgs([])).toEqual({
      days: DEFAULT_DAYS,
      limit: DEFAULT_LIMIT,
      showEmails: false,
      json: false,
    });
    expect(DEFAULT_DAYS).toBe(7);
    expect(DEFAULT_LIMIT).toBe(20);
  });

  it("parses every flag, ignores one leading -- (pnpm forwarding)", () => {
    expect(
      parseReportArgs(["--", "--days", "30", "--limit", "1000", "--show-emails", "--json"]),
    ).toEqual({
      days: 30,
      limit: 1000,
      showEmails: true,
      json: true,
    });
  });

  it("bounds: days 1..30, limit 1..1000", () => {
    expect(MAX_DAYS).toBe(30);
    expect(MAX_LIMIT).toBe(1000);
    expect(parseReportArgs(["--days", "1"]).days).toBe(1);
    expect(parseReportArgs(["--limit", "1"]).limit).toBe(1);
    for (const bad of [
      ["--days", "0"],
      ["--days", "31"],
      ["--limit", "0"],
      ["--limit", "1001"],
      ["--days", "-1"],
      ["--days", "1.5"],
      ["--days", "abc"],
      ["--days"],
      ["--limit", "--json"],
      ["--bogus"],
      ["positional"],
    ])
      expect(() => parseReportArgs(bad), bad.join(" ")).toThrow(UsageError);
  });

  it("main() exits 2 on bad arguments without touching the database", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out: string[] = [];
    try {
      expect(
        await main(["--days", "99"], { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }, (t) =>
          out.push(t),
        ),
      ).toBe(2);
      expect(await main(["--wat"], {}, (t) => out.push(t))).toBe(2);
      expect(out).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
});

describe("pendingWatchFrom and formatBytes", () => {
  it("50 % of the pending limit, at least 1", () => {
    expect(pendingWatchFrom(200)).toBe(100);
    expect(pendingWatchFrom(1)).toBe(1);
    expect(pendingWatchFrom(3)).toBe(2);
    expect(pendingWatchFrom(2)).toBe(1);
  });

  it("formats bytes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

// ---- fixtures ----------------------------------------------------------------------------------

function report(over: Partial<AbuseReport> = {}): AbuseReport {
  return {
    generatedAt: "2026-10-11T12:34:56.000Z",
    windowDays: 7,
    limit: 20,
    showEmails: false,
    pendingLimit: 200,
    videoLimit: 100,
    fairUseBytes: 200 * 1024 * 1024 * 1024,
    familyStartsPerNetwork: [
      {
        network: "abcdef012345",
        starts: 4,
        accounts: 3,
        firstAt: "2026-10-10T01:00:00.000Z",
        lastAt: "2026-10-11T01:00:00.000Z",
      },
    ],
    families: [
      {
        familyId: FAMILY,
        parents: 2,
        freeAlbums: 2,
        photos: 1000,
        videos: 12,
        pending: 3,
        bytes: 5_000_000,
        pct: 100,
        over: false,
        videosOver: false,
      },
      {
        familyId: "44444444-4444-4444-8444-444444444444",
        parents: 1,
        freeAlbums: 1,
        photos: 1012,
        videos: 101,
        pending: 0,
        bytes: 6_000_000,
        pct: 101.2,
        over: true,
        videosOver: true,
      },
    ],
    topStorage: {
      albums: [
        {
          babyId: BABY,
          familyId: FAMILY,
          plan: "free",
          photos: 500,
          videos: 3,
          pending: 1,
          bytes: 2048,
          videoBytes: 1024,
          trashed: false,
        },
      ],
      families: [
        {
          familyId: FAMILY,
          parents: 2,
          albums: 2,
          photos: 1000,
          videos: 3,
          bytes: 5_000_000,
          videoBytes: 1024,
          fairUse: false,
        },
      ],
    },
    recentFamilyStarts: [
      {
        familyId: FAMILY,
        userId: USER,
        createdAt: "2026-10-11T01:00:00.000Z",
        client: "web",
        network: "abcdef012345",
        flags: ["plus_tag", "canonical_dup"],
      },
      {
        familyId: null,
        userId: null,
        createdAt: "2026-10-10T01:00:00.000Z",
        client: "native",
        network: "abcdef012345",
        flags: [],
      },
    ],
    pendingQueues: [{ familyId: FAMILY, userId: USER, pending: 150 }],
    canonicalInboxes: [
      {
        userIds: [USER, "55555555-5555-4555-8555-555555555555"],
        accounts: 2,
        parents: 1,
        families: 1,
        firstAt: "2026-10-09T01:00:00.000Z",
        lastAt: "2026-10-11T01:00:00.000Z",
      },
    ],
    ...over,
  };
}

describe("renderText", () => {
  it("prints all six section headers and the OVER marker", () => {
    const text = renderText(report());
    for (const header of [
      "1. Family starts per network",
      "2. Families near or over the pool",
      "3. Top storage",
      "4. Recent family starts",
      "5. Pending queues",
      "6. Canonical-inbox clusters",
    ])
      expect(text, header).toContain(header);
    expect(text).toContain("   Albums");
    expect(text).toContain("   Families");
    const overLines = text.split("\n").filter((l) => l.includes("OVER"));
    expect(overLines).toHaveLength(1);
    expect(overLines[0]).toContain("101.2%");
    expect(text.split("\n").find((l) => l.includes("100.0%"))).not.toContain("OVER");
  });

  it("holds no '@' without --show-emails, and no warning", () => {
    const text = renderText(report());
    expect(text).not.toContain("@");
    expect(text).not.toContain(PERSONAL_DATA_WARNING);
    expect(text).not.toContain("emails");
  });

  it("purged families and deleted accounts read 'purged' and 'deleted'", () => {
    const text = renderText(report());
    expect(text).toContain("purged");
    expect(text).toContain("deleted");
  });

  it("--show-emails adds the warning and an emails column", () => {
    const text = renderText(
      report({
        showEmails: true,
        families: [
          {
            ...(report().families[0] as AbuseReport["families"][number]),
            emails: "mom@example.com, dad@example.com",
          },
        ],
      }),
    );
    expect(text.startsWith(PERSONAL_DATA_WARNING)).toBe(true);
    expect(text).toContain("emails");
    expect(text).toContain("mom@example.com, dad@example.com");
  });

  it("empty sections say (none)", () => {
    const text = renderText(
      report({
        familyStartsPerNetwork: [],
        families: [],
        topStorage: { albums: [], families: [] },
        recentFamilyStarts: [],
        pendingQueues: [],
        canonicalInboxes: [],
      }),
    );
    expect(text.match(/\(none\)/g)).toHaveLength(7);
  });

  it("sections 4-6 stop at 200 rows with '... N more'", () => {
    const many = <T>(row: T, n: number) => Array.from({ length: n }, () => row);
    const r = report();
    const text = renderText(
      report({
        recentFamilyStarts: many(
          r.recentFamilyStarts[0] as AbuseReport["recentFamilyStarts"][number],
          TEXT_ROWS_MAX + 5,
        ),
        pendingQueues: many(
          r.pendingQueues[0] as AbuseReport["pendingQueues"][number],
          TEXT_ROWS_MAX + 7,
        ),
        canonicalInboxes: many(
          r.canonicalInboxes[0] as AbuseReport["canonicalInboxes"][number],
          TEXT_ROWS_MAX + 9,
        ),
      }),
    );
    expect(TEXT_ROWS_MAX).toBe(200);
    expect(text).toContain("... 5 more");
    expect(text).toContain("... 7 more");
    expect(text).toContain("... 9 more");
    expect(renderText(report())).not.toContain("more (use --json");
  });

  it("section 5 names its threshold from the report's pending limit", () => {
    expect(renderText(report({ pendingLimit: 200 }))).toContain("100 or more of 200");
    expect(renderText(report({ pendingLimit: 1 }))).toContain("1 or more of 1");
  });
});

// ---- collectReport with a scripted client --------------------------------------------------------

function scriptedClient(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const at = new Date("2026-10-11T01:00:00.000Z");
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("pending_photo_limit()")) return { rows: [{ limit: 200 }] };
      if (sql.includes("FROM public.family_starts s") && sql.includes("GROUP BY s.ip_hash"))
        return {
          rows: [{ network: "abcdef012345", starts: 3, accounts: 3, first_at: at, last_at: at }],
        };
      if (sql.includes("WITH pool AS"))
        return {
          rows: [
            {
              family_id: FAMILY,
              free_albums: 2,
              photos: 1000,
              bytes: "5000",
              parents: 2,
              pending: 4,
              emails: "a@example.com",
            },
          ],
        };
      if (
        sql.includes("FROM public.babies b") &&
        sql.includes("LIMIT $1") &&
        sql.includes("b.id AS baby_id")
      )
        return {
          rows: [
            {
              baby_id: BABY,
              family_id: FAMILY,
              plan: "free",
              photos: 10,
              pending: 1,
              bytes: "99",
              trashed: false,
              emails: "a@example.com",
            },
          ],
        };
      if (sql.includes("WITH fam AS"))
        return {
          rows: [
            {
              family_id: FAMILY,
              albums: 2,
              photos: 10,
              bytes: "99",
              parents: 2,
              emails: "a@example.com",
            },
          ],
        };
      if (sql.includes("canonical_dup"))
        return {
          rows: [
            {
              family_id: FAMILY,
              user_id: USER,
              created_at: at,
              client: "web",
              network: "abcdef012345",
              plus_tag: true,
              dots_folded: true,
              canonical_dup: true,
              suspended: true,
              emails: "a@example.com",
            },
          ],
        };
      if (sql.includes("HAVING count(*) >= $1::int"))
        return {
          rows: [{ family_id: FAMILY, user_id: USER, pending: 120, emails: "a@example.com" }],
        };
      if (sql.includes("GROUP BY p.email_canonical"))
        return {
          rows: [
            {
              user_ids: [USER],
              accounts: 2,
              parents: 1,
              families: 1,
              first_at: at,
              last_at: at,
              emails: "a@example.com, b@example.com",
            },
          ],
        };
      return { rows: [] };
    },
  };
}

const asQueryable = (c: unknown) => c as Parameters<typeof collectReport>[0];

describe("collectReport: the JSON shape", () => {
  it("has exactly the documented keys", async () => {
    const r = await collectReport(asQueryable(scriptedClient()), {
      days: 7,
      limit: 20,
      showEmails: false,
      json: true,
    });
    expect(Object.keys(r).sort()).toEqual(
      [
        "generatedAt",
        "fairUseBytes",
        "videoLimit",
        "windowDays",
        "limit",
        "showEmails",
        "pendingLimit",
        "familyStartsPerNetwork",
        "families",
        "topStorage",
        "recentFamilyStarts",
        "pendingQueues",
        "canonicalInboxes",
      ].sort(),
    );
    expect(Object.keys(r.topStorage).sort()).toEqual(["albums", "families"]);
    expect(r).toMatchObject({ windowDays: 7, limit: 20, showEmails: false, pendingLimit: 200 });
  });

  it("maps rows to camelCase, derives pct/over, and turns flags into a list", async () => {
    const r = await collectReport(asQueryable(scriptedClient()), {
      days: 7,
      limit: 20,
      showEmails: false,
      json: true,
    });
    expect(r.families[0]).toEqual({
      familyId: FAMILY,
      parents: 2,
      freeAlbums: 2,
      photos: 1000,
      pending: 4,
      bytes: 5000,
      pct: 100,
      over: false,
      videosOver: false,
    });
    expect(r.recentFamilyStarts[0]?.flags).toEqual([
      "plus_tag",
      "dots_folded",
      "canonical_dup",
      "suspended",
    ]);
    expect(r.familyStartsPerNetwork[0]).toMatchObject({ network: "abcdef012345", starts: 3 });
    expect(r.pendingQueues[0]).toEqual({ familyId: FAMILY, userId: USER, pending: 120 });
  });

  it("without --show-emails no row carries an emails key and the JSON holds no '@'", async () => {
    const r = await collectReport(asQueryable(scriptedClient()), {
      days: 7,
      limit: 20,
      showEmails: false,
      json: true,
    });
    expect(JSON.stringify(r)).not.toContain("@");
    expect(JSON.stringify(r)).not.toContain('emails":');
  });

  it("with --show-emails the rows carry the addresses", async () => {
    const r = await collectReport(asQueryable(scriptedClient()), {
      days: 7,
      limit: 20,
      showEmails: true,
      json: true,
    });
    expect(r.families[0]?.emails).toBe("a@example.com");
    expect(r.canonicalInboxes[0]?.emails).toContain("b@example.com");
  });

  it("passes the window, limit, the email switch and the pending threshold as bind parameters", async () => {
    const c = scriptedClient();
    await collectReport(asQueryable(c), { days: 3, limit: 9, showEmails: true, json: false });
    const byFragment = (frag: string) => c.calls.find((x) => x.sql.includes(frag))?.params;
    expect(byFragment("GROUP BY s.ip_hash")).toEqual([3]);
    // step 12: the pool query also binds the effective video limit (default 100)
    expect(byFragment("WITH pool AS")).toEqual([true, 100]);
    expect(byFragment("b.id AS baby_id")).toEqual([9, true]);
    expect(byFragment("canonical_dup")).toEqual([3, true]);
    expect(byFragment("HAVING count(*) >= $1::int")).toEqual([100, true]);
  });
});

describe("source hygiene (user constraint: never compare photos across accounts)", () => {
  const source = readFileSync(fileURLToPath(new URL("./abuse-report.ts", import.meta.url)), "utf8");

  it("reads no photo digest, perceptual hash or embedding", () => {
    expect(source).not.toMatch(/sha256|phash|embedding/i);
  });

  it("is read-only: no write statement in the SQL", () => {
    const sqlBlocks = source.match(/const SQL_[A-Z_]+ = `[\s\S]*?`;/g) ?? [];
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(7);
    for (const b of sqlBlocks)
      expect(b, b.slice(0, 40)).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/);
    expect(source).toContain("BEGIN READ ONLY");
  });

  it("never selects the canonical address itself", () => {
    const block = source.match(/const SQL_CANONICAL_INBOXES = `[\s\S]*?`;/)?.[0] ?? "";
    expect(block).toContain("GROUP BY p.email_canonical");
    expect(block).not.toMatch(/SELECT[^;]*p\.email_canonical\s+AS/);
  });
});
