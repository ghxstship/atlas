import { ASSET_STATES } from "@xos/data/assets";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_UNIT_VIEWS,
  inBuiltInUnitView,
  isBuiltInUnitView,
  isDamagedUnit,
  isHiredInUnit,
  isUnavailableUnit,
  type UnitViewFacts,
} from "@/lib/assets/views";

/** The built-in views of the units list (R7a, G-96): pure predicates over a unit's state and acquisition. */

const unit = (
  state: UnitViewFacts["state"],
  acquisitionKind: UnitViewFacts["acquisitionKind"] = "Purchase",
) => ({
  state,
  acquisitionKind,
});

describe("built-in unit views (G-96)", () => {
  it("knows its three filter keys and nothing else", () => {
    expect(BUILT_IN_UNIT_VIEWS).toEqual(["view:damaged", "view:hired-in", "view:unavailable"]);
    expect(isBuiltInUnitView("view:hired-in")).toBe(true);
    expect(isBuiltInUnitView("Damaged")).toBe(false);
    expect(isBuiltInUnitView(undefined)).toBe(false);
  });

  it("Damaged lists only Damaged units", () => {
    expect(ASSET_STATES.filter((s) => isDamagedUnit(unit(s)))).toEqual(["Damaged"]);
  });

  it("Hired in lists rental units until they go back to the vendor", () => {
    expect(isHiredInUnit(unit("Available", "Rental"))).toBe(true);
    expect(isHiredInUnit(unit("Damaged", "Rental"))).toBe(true);
    expect(isHiredInUnit(unit("Returned", "Rental"))).toBe(false);
    expect(isHiredInUnit(unit("Available", "Purchase"))).toBe(false);
  });

  it("Unavailable lists every state but Available, Returned included", () => {
    expect(ASSET_STATES.filter((s) => !isUnavailableUnit(unit(s)))).toEqual(["Available"]);
    expect(isUnavailableUnit(unit("Returned", "Rental"))).toBe(true);
  });

  it("routes each filter key to its predicate", () => {
    const returned = unit("Returned", "Rental");
    expect(inBuiltInUnitView("view:hired-in", returned)).toBe(false);
    expect(inBuiltInUnitView("view:unavailable", returned)).toBe(true);
    expect(inBuiltInUnitView("view:damaged", unit("Damaged"))).toBe(true);
  });
});
