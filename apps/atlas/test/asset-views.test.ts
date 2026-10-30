import { ASSET_STATES } from "@xos/data/assets";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_UNIT_PRESETS,
  presetFilters,
  unitConditions,
  unitMatches,
  type UnitViewFacts,
} from "@/lib/assets/views";
import { builtInViewEntries } from "@/lib/assets/built-in-views";
import { viewToQuery } from "@/lib/views/query";

/**
 * The built-in views of the units list (R7a, G-96): presets of the declared state and acquisition conditions
 * (A117), matched on stored values.
 */

const unit = (
  state: UnitViewFacts["state"],
  acquisitionKind: UnitViewFacts["acquisitionKind"] = "Purchase",
): UnitViewFacts => ({ state, acquisitionKind });

const preset = (id: (typeof BUILT_IN_UNIT_PRESETS)[number]["id"]) =>
  BUILT_IN_UNIT_PRESETS.find((p) => p.id === id)?.filters ?? [];

describe("built-in unit views (G-96)", () => {
  it("are the three presets, in order", () => {
    expect(BUILT_IN_UNIT_PRESETS.map((p) => p.id)).toEqual(["damaged", "hiredIn", "unavailable"]);
  });

  it("Damaged lists only Damaged units", () => {
    expect(ASSET_STATES.filter((s) => unitMatches(preset("damaged"), unit(s)))).toEqual([
      "Damaged",
    ]);
  });

  it("Hired in lists rental units until they go back to the vendor", () => {
    const hired = preset("hiredIn");
    expect(unitMatches(hired, unit("Available", "Rental"))).toBe(true);
    expect(unitMatches(hired, unit("Damaged", "Rental"))).toBe(true);
    expect(unitMatches(hired, unit("Returned", "Rental"))).toBe(false);
    expect(unitMatches(hired, unit("Available", "Purchase"))).toBe(false);
  });

  it("Unavailable lists every state but Available, Returned included", () => {
    expect(
      ASSET_STATES.filter((s) => !unitMatches(preset("unavailable"), unit(s, "Rental"))),
    ).toEqual(["Available"]);
  });

  it("round-trips through the query a saved copy keeps", () => {
    const query = viewToQuery(
      {
        viewType: "Table",
        searchText: null,
        groupByField: null,
        filters: presetFilters(preset("hiredIn")),
        sorts: [],
      },
      ["table"],
    );
    expect(query).toBe("view=table&f.acquisition=Rental&f.state.ne=Returned");
    const back = unitConditions(new URLSearchParams(query).toString());
    expect(back).toEqual(preset("hiredIn"));
  });

  it("reads only the declared fields, whatever the case of a value", () => {
    expect(unitConditions("f.state=damaged&cf.tier=gold&f.vendor=acme")).toEqual([
      { scope: "field", key: "state", operator: "eq", value: "damaged" },
    ]);
    expect(unitMatches(unitConditions("f.state=damaged"), unit("Damaged"))).toBe(true);
    expect(unitMatches([], unit("Lost"))).toBe(true);
  });

  it("open on the view type shown, and the one whose query is on screen is current", () => {
    const presets = BUILT_IN_UNIT_PRESETS.map((p) => ({
      id: p.id,
      name: p.id,
      filters: presetFilters(p.filters),
    }));
    const entries = builtInViewEntries(
      presets,
      new URLSearchParams("view=board&f.state.ne=Available&peek=RAD-1"),
      "board",
      ["table", "board"],
    );
    expect(entries.map((e) => e.query)).toEqual([
      "view=board&f.state=Damaged",
      "view=board&f.acquisition=Rental&f.state.ne=Returned",
      "view=board&f.state.ne=Available",
    ]);
    expect(entries.map((e) => e.active)).toEqual([false, false, true]);
    const searched = builtInViewEntries(
      presets,
      new URLSearchParams("view=board&f.state.ne=Available&q=radio"),
      "board",
      ["table", "board"],
    );
    expect(searched.some((e) => e.active)).toBe(false);
  });
});
