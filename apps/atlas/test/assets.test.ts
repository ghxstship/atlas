import { describe, expect, it } from "vitest";
import { currencyExponent, majorUnits, minorUnits } from "@/lib/assets/money";
import {
  ASSET_STATE_TONE,
  displayKey,
  keyedTitle,
  matches,
  pickView,
  readQuery,
} from "@/lib/assets/views";
import { monthOf } from "@/lib/assets/page";

describe("assets row keys (A59-009)", () => {
  it("shows the asset tag, never a row id, in the key column", () => {
    const id = "01a15673-0725-7bb5-9482-0e505cbbbe98";
    expect(displayKey({ key: id, peek: id, recordKey: "MH-004", title: "Hoist service" })).toBe(
      "MH-004",
    );
    expect(displayKey({ key: id, peek: id, title: "Truss lot" })).toBe("");
    expect(displayKey({ key: "u1", peek: "LX-001", title: "Mover" })).toBe("LX-001");
    expect(keyedTitle({ key: id, recordKey: "MH-004", title: "Hoist service" })).toBe(
      "MH-004 · Hoist service",
    );
    expect(keyedTitle({ key: id, title: "Truss lot" })).toBe("Truss lot");
  });
});

describe("assets money", () => {
  it("converts typed amounts to minor units by the currency exponent", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(minorUnits("125.50", "USD")).toBe(12550);
    expect(minorUnits("1,200", "USD")).toBe(120000);
    expect(minorUnits("1200", "JPY")).toBe(1200);
    expect(minorUnits("1.234", "USD")).toBeNull();
    expect(minorUnits("abc", "USD")).toBeNull();
  });

  it("keeps an unknown amount unknown", () => {
    expect(majorUnits(null, "USD")).toBeNull();
    expect(majorUnits(12550, null)).toBeNull();
    expect(majorUnits(12550, "USD")).toBe(125.5);
  });
});

describe("assets views", () => {
  it("offers only the views the sitemap lists", () => {
    expect(pickView("board", ["table", "list"], "table")).toBe("table");
    expect(pickView("list", ["table", "list"], "table")).toBe("list");
    expect(pickView(undefined, ["map"], "map")).toBe("table");
  });

  it("reads the list query string", () => {
    expect(readQuery({ view: "list", peek: "MH-001", q: ["a", "b"], other: "x" })).toEqual({
      view: "list",
      peek: "MH-001",
    });
  });

  it("matches a search case-insensitively across fields", () => {
    expect(matches(undefined, "anything")).toBe(true);
    expect(matches("rad", "NWL-RAD-001", null)).toBe(true);
    expect(matches("truss", "Radio", undefined)).toBe(false);
  });

  it("gives every asset state an icon tone", () => {
    expect(Object.keys(ASSET_STATE_TONE)).toHaveLength(9);
    expect(ASSET_STATE_TONE["Damaged"]).toBe("blocked");
    expect(monthOf("2026-10-15")).toBe("2026-10-01");
  });
});
