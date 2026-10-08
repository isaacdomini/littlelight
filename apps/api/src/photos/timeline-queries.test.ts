import { ageGroupSortValue, PHOTO_DETAILS_LIMITS } from "@littlelight/shared";
import { describe, expect, it } from "vitest";
import {
  batchDetailsSql,
  decodeCursor,
  detailsUpsertSql,
  encodeCursor,
  listPhotosSql,
  MAX_UUID,
  normalizePeople,
  type PhotoSummaryRow,
  pageCursors,
  toPhotoGroups,
  toPhotoPage,
} from "./queries";

const BABY = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";
const MS = "33333333-3333-4333-8333-333333333333";
const cursor = {
  sortKey: "2026-06-14T12:00:00.123456Z",
  id: "44444444-4444-4444-8444-444444444444",
};

describe("listPhotosSql", () => {
  const base = { babyId: BABY, view: "album" as const, limit: 200 };

  it("first page: newest first, no keyset, limit + 1 as the look-ahead", () => {
    const { text, values } = listPhotosSql({ ...base, cursor: null });
    expect(text).toMatch(/ORDER BY p\.sort_at DESC, p\.id DESC/);
    expect(text).not.toMatch(/\(p\.sort_at, p\.id\) [<>]/);
    expect(values).toEqual([BABY, 201]);
  });

  it("older: (sort_at, id) < cursor with typed parameters, descending", () => {
    const { text, values } = listPhotosSql({ ...base, cursor, dir: "older" });
    expect(text).toContain("(p.sort_at, p.id) < ($2::timestamptz, $3::uuid)");
    expect(text).toMatch(/ORDER BY p\.sort_at DESC, p\.id DESC/);
    expect(values).toEqual([BABY, cursor.sortKey, cursor.id, 201]);
  });

  it("newer: > cursor and ascending (the index is walked backwards)", () => {
    const { text } = listPhotosSql({ ...base, cursor, dir: "newer" });
    expect(text).toContain("(p.sort_at, p.id) > ($2::timestamptz, $3::uuid)");
    expect(text).toMatch(/ORDER BY p\.sort_at ASC, p\.id ASC/);
  });

  it("dir=newer without a cursor does not flip", () => {
    const { text } = listPhotosSql({ ...base, cursor: null, dir: "newer" });
    expect(text).toMatch(/ORDER BY p\.sort_at DESC, p\.id DESC/);
    expect(text).not.toContain("ASC");
  });

  it("never uses COALESCE in the sort or the bound (keeps the Index Cond under RLS)", () => {
    const { text } = listPhotosSql({ ...base, cursor });
    expect(text).not.toMatch(/ORDER BY[^;]*COALESCE/i);
    expect(text).not.toMatch(/\(COALESCE/i);
  });

  it("milestoneId adds an EXISTS on photo_details with the id as a parameter", () => {
    const { text, values } = listPhotosSql({ ...base, cursor, milestoneId: MS });
    expect(text).toMatch(/EXISTS \(SELECT 1 FROM public\.photo_details f/);
    expect(text).toContain("f.milestone_id = $2::uuid");
    expect(text).toContain("($3::timestamptz, $4::uuid)");
    expect(values).toEqual([BABY, MS, cursor.sortKey, cursor.id, 201]);
    expect(text).not.toContain(MS);
  });

  it("no milestone filter without the option", () => {
    expect(listPhotosSql({ ...base, cursor: null }).text).not.toContain("photo_details f");
    expect(listPhotosSql({ ...base, cursor: null, milestoneId: null }).text).not.toContain(
      "photo_details f",
    );
  });

  it("the view filters differ: trash is deleted, album/pending are live and hide failed ingests", () => {
    const album = listPhotosSql({ ...base, cursor: null }).text;
    const pending = listPhotosSql({ ...base, view: "pending", cursor: null }).text;
    const trash = listPhotosSql({ ...base, view: "trash", cursor: null }).text;
    expect(album).toContain("p.deleted_at IS NULL");
    expect(album).toContain("'failed', 'duplicate'");
    expect(pending).toContain("p.approval = 'pending'");
    expect(trash).toContain("p.deleted_at IS NOT NULL");
  });

  it("never interpolates ids or cursor parts into the SQL text", () => {
    const { text } = listPhotosSql({ ...base, cursor, milestoneId: MS });
    for (const v of [BABY, MS, cursor.id, cursor.sortKey]) expect(text).not.toContain(v);
  });
});

describe("toPhotoPage / pageCursors", () => {
  const mk = (n: number) =>
    ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      sort_key: `2026-01-${String(10 + n).padStart(2, "0")}T00:00:00.000000Z`,
    }) as unknown as PhotoSummaryRow & { sort_key: string };

  it("older: trims the look-ahead row, reports more and keeps the order", () => {
    // newest first: 5,4,3 (3 = look-ahead for limit 2)
    const page = toPhotoPage([mk(5), mk(4), mk(3)], 2, false);
    expect(page.rows.map((r) => r.id.slice(-1))).toEqual(["5", "4"]);
    expect(page.more).toBe(true);
    expect(page.first?.id).toBe(mk(5).id);
    expect(page.last?.id).toBe(mk(4).id);
    expect(page.rows[0]).not.toHaveProperty("sort_key");
  });

  it("newer: the rows come ascending from SQL and are reversed to newest first", () => {
    // ascending from SQL: 3,4,5 (limit 2 -> 5 is the look-ahead, i.e. there are newer ones)
    const page = toPhotoPage([mk(3), mk(4), mk(5)], 2, true);
    expect(page.rows.map((r) => r.id.slice(-1))).toEqual(["4", "3"]);
    expect(page.more).toBe(true);
    expect(page.first?.id).toBe(mk(4).id);
    expect(page.last?.id).toBe(mk(3).id);
  });

  it("empty page: no cursors", () => {
    const page = toPhotoPage([], 10, false);
    expect(page).toEqual({ rows: [], first: null, last: null, more: false });
    expect(pageCursors(page, "older", false)).toEqual({ nextCursor: null, prevCursor: null });
  });

  it("older: next only when more exist, prev is the first item", () => {
    const more = pageCursors(toPhotoPage([mk(5), mk(4), mk(3)], 2, false), "older", true);
    expect(decodeCursor(more.nextCursor as string).id).toBe(mk(4).id);
    expect(decodeCursor(more.prevCursor as string).id).toBe(mk(5).id);
    const end = pageCursors(toPhotoPage([mk(5), mk(4)], 2, false), "older", true);
    expect(end.nextCursor).toBeNull();
    expect(end.prevCursor).not.toBeNull();
  });

  it("newer: prev only when more newer exist, next is the last item", () => {
    const more = pageCursors(toPhotoPage([mk(3), mk(4), mk(5)], 2, true), "newer", true);
    expect(decodeCursor(more.prevCursor as string).id).toBe(mk(4).id);
    expect(decodeCursor(more.nextCursor as string).id).toBe(mk(3).id);
    const top = pageCursors(toPhotoPage([mk(3), mk(4)], 2, true), "newer", true);
    expect(top.prevCursor).toBeNull();
    expect(top.nextCursor).not.toBeNull();
  });

  it("dir=newer without a cursor behaves like older", () => {
    const page = toPhotoPage([mk(5), mk(4), mk(3)], 2, false);
    expect(pageCursors(page, "newer", false)).toEqual(pageCursors(page, "older", false));
  });
});

describe("toPhotoGroups", () => {
  it("orders groups by descending age (unknown, years, months, weeks, pre) with MAX_UUID jump cursors", () => {
    const top = (d: number) => `2026-0${d}-01T00:00:00.000001Z`;
    const rows = [
      { key: "w1", n: 3, top: top(1) },
      { key: "pre", n: 1, top: top(2) },
      { key: "m12", n: 5, top: top(3) },
      { key: "unknown", n: 2, top: top(4) },
      { key: "y2", n: 7, top: top(5) },
      { key: "w12", n: 4, top: top(6) },
      { key: "m3", n: 1, top: top(7) },
    ];
    const { total, groups } = toPhotoGroups(rows);
    expect(groups.map((g) => g.key)).toEqual(["unknown", "y2", "m12", "m3", "w12", "w1", "pre"]);
    expect(total).toBe(23);
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(total);
    for (const g of groups) {
      const c = decodeCursor(g.cursor);
      expect(c.id).toBe(MAX_UUID);
      expect(c.sortKey).toBe(rows.find((r) => r.key === g.key)?.top);
    }
    const values = groups.map((g) => ageGroupSortValue(g.key));
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it("is deterministic for an unrecognised key (sorted last) and empty input", () => {
    expect(toPhotoGroups([])).toEqual({ total: 0, groups: [] });
    const { groups } = toPhotoGroups([
      { key: "zzz", n: 1, top: "2026-01-01T00:00:00.000000Z" },
      { key: "w1", n: 1, top: "2026-01-01T00:00:00.000000Z" },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["w1", "zzz"]);
  });

  it("MAX_UUID is a valid cursor id and above every v4 uuid", () => {
    expect(() =>
      decodeCursor(encodeCursor({ sortKey: cursor.sortKey, id: MAX_UUID })),
    ).not.toThrow();
    expect(MAX_UUID > "fffffffe-ffff-4fff-bfff-ffffffffffff").toBe(true);
  });
});

describe("normalizePeople", () => {
  it("drops blanks, de-duplicates case-insensitively keeping the first spelling and order", () => {
    expect(normalizePeople(["Grandma Rose", "  ", "dad", "GRANDMA ROSE", "Dad", "Nanny"])).toEqual([
      "Grandma Rose",
      "dad",
      "Nanny",
    ]);
  });
  it("trims and truncates to the chip limit", () => {
    expect(normalizePeople(["  Mia  "])).toEqual(["Mia"]);
    expect(normalizePeople(["x".repeat(100)])[0]).toHaveLength(PHOTO_DETAILS_LIMITS.personName);
    expect(normalizePeople([])).toEqual([]);
  });
});

describe("detailsUpsertSql", () => {
  it("sends only the provided fields and passes every value as a parameter", () => {
    const { text, values } = detailsUpsertSql(MS, UID, { note: "three wobbly steps" });
    expect(text).toContain("(photo_id, edited_by, note)");
    expect(text).not.toContain("people");
    expect(text).not.toContain("location_label");
    expect(text).not.toContain("milestone_id");
    expect(text).toContain("DO UPDATE SET edited_by = EXCLUDED.edited_by, note = EXCLUDED.note");
    expect(values).toEqual([MS, UID, "three wobbly steps"]);
    expect(text).not.toContain("wobbly");
  });

  it("null clears a scalar, blank becomes NULL, people replaces the array (normalized)", () => {
    const { values, text } = detailsUpsertSql(MS, UID, {
      milestoneId: null,
      note: "   ",
      locationLabel: null,
      people: ["Dad", "dad", "Mom"],
    });
    expect(text).toContain("milestone_id");
    expect(text).toContain("::text[]");
    expect(values).toEqual([MS, UID, null, null, null, ["Dad", "Mom"]]);
  });

  it("an injection attempt stays a parameter", () => {
    const evil = "'); DROP TABLE photo_details;--";
    const { text, values } = detailsUpsertSql(MS, UID, { locationLabel: evil, people: [evil] });
    expect(text).not.toContain("DROP");
    expect(values).toContain(evil);
  });
});

describe("batchDetailsSql", () => {
  const ids = [MS, UID];

  it("merges people and only touches provided fields", () => {
    const { text, values } = batchDetailsSql(BABY, UID, ids, { addPeople: ["Nanny", "nanny"] });
    expect(values.slice(0, 5)).toEqual([ids, BABY, UID, ["Nanny"], PHOTO_DETAILS_LIMITS.people]);
    expect(text).toContain("people = EXCLUDED.people");
    expect(text).toContain("public.photo_editable(p.id)");
    expect(text).toContain("p.baby_id = $2::uuid");
    expect(text).toContain("cardinality(m.people) <= $5::int");
    expect(text).not.toContain("note");
    expect(text).not.toContain("milestone_id");
  });

  it("without addPeople the existing people are not rewritten", () => {
    const { text } = batchDetailsSql(BABY, UID, ids, { milestoneId: MS });
    expect(text).not.toContain("people = EXCLUDED.people");
    expect(text).toContain("milestone_id = EXCLUDED.milestone_id");
  });

  it("scalars are parameters appended after the fixed five", () => {
    const { text, values } = batchDetailsSql(BABY, UID, ids, {
      note: "beach",
      locationLabel: "Pier",
    });
    expect(values.slice(5)).toEqual(["beach", "Pier"]);
    expect(text).not.toContain("beach");
    expect(text).not.toContain("Pier");
  });
});
