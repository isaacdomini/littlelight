import { describe, expect, it } from "vitest";
import { CSV_BOM, CSV_EOL, csvCell, csvHeader, csvRow } from "./csv";

describe("csvCell", () => {
  it.each([
    ["plain", "plain"],
    ["with,comma", '"with,comma"'],
    ['with "quote"', '"with ""quote"""'],
    ["line\nbreak", '"line\nbreak"'],
    ["cr\rhere", '"cr\rhere"'],
    ["", ""],
  ])("quotes %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it.each(["=SUM(A1)", "+1", "-1+2", "@cmd", "\tx", "\rx"])(
    "guards the formula start %j with a leading apostrophe",
    (v) => {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it('guards before quoting: =HYPERLINK("x","y") stays inert', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it("never touches numbers, even negative ones", () => {
    expect(csvCell(-122.3321)).toBe("-122.3321");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("writes booleans as true/false and nulls as empty", () => {
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("keeps unicode and emoji as is", () => {
    expect(csvCell("Zoë 🎉")).toBe("Zoë 🎉");
  });
});

describe("csvRow / csvHeader", () => {
  it("terminate with CRLF and join with commas", () => {
    expect(csvRow(["a", 1, null, "b,c"])).toBe(`a,1,,"b,c"${CSV_EOL}`);
    expect(csvHeader(["x", "y"])).toBe(`x,y${CSV_EOL}`);
    expect(CSV_EOL).toBe("\r\n");
  });

  it("the BOM is U+FEFF", () => {
    expect(CSV_BOM).toBe("﻿");
  });
});
