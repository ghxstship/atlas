import type { RosterProjectFacts } from "@xos/data/roster-facts";
import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_FIELDS, chipState, stepFields, wizardSteps } from "../lib/roster-facts-steps";

/**
 * The project facts wizard (R5): a step for each kind the project offers, then Review; at most seven fields before More
 * fields on every step; in company mode a kind the person entered is read-only.
 */

const none = { travel: false, uniform: false, vehicle: false };

function facts(over: Partial<RosterProjectFacts> = {}): RosterProjectFacts {
  return {
    rosterEntryId: "r1",
    engagementId: "e1",
    orgId: "o1",
    personId: "p1",
    standing: "Person",
    offered: { travel: true, lodging: true, uniforms: true, parking: true },
    present: none,
    enteredByPerson: none,
    readable: ["Travel", "Uniform", "Vehicle"],
    travel: null,
    uniform: null,
    vehicle: null,
    ...over,
  };
}

const kinds = (f: RosterProjectFacts, mode: "person" | "company" = "person") =>
  wizardSteps(f, mode).map((s) => s.kind);

describe("wizard steps", () => {
  it("asks every offered kind, then Review", () => {
    expect(kinds(facts())).toEqual(["Travel", "Uniform", "Vehicle", "Review"]);
  });

  it("leaves out the kinds the project does not offer", () => {
    expect(
      kinds(facts({ offered: { travel: false, lodging: true, uniforms: true, parking: false } })),
    ).toEqual(["Uniform", "Review"]);
    expect(
      kinds(facts({ offered: { travel: false, lodging: false, uniforms: false, parking: true } })),
    ).toEqual(["Vehicle", "Review"]);
    // Lodging alone asks nothing: the lodging question is part of the travel step.
    expect(
      kinds(facts({ offered: { travel: false, lodging: true, uniforms: false, parking: false } })),
    ).toEqual(["Review"]);
  });
});

describe("fields per step", () => {
  const offered = facts().offered;

  it("shows at most seven fields before More fields", () => {
    for (const kind of ["Travel", "Uniform", "Vehicle"] as const) {
      const plan = stepFields(kind, offered);
      expect(plan.visible.length).toBeLessThanOrEqual(MAX_VISIBLE_FIELDS);
      expect(plan.visible.filter((f) => plan.more.includes(f))).toEqual([]);
    }
    expect(stepFields("Travel", offered).more).toEqual(["mealPreference", "travelNotes"]);
    expect(stepFields("Uniform", offered).more).toEqual(["pantsWaistIn", "pantsInseamIn"]);
  });

  it("asks about lodging only while lodging is offered", () => {
    expect(stepFields("Travel", offered).visible).toContain("needsLodging");
    expect(stepFields("Travel", { ...offered, lodging: false }).visible).not.toContain(
      "needsLodging",
    );
  });
});

describe("company mode", () => {
  it("is read-only for the kinds the person entered", () => {
    const steps = wizardSteps(
      facts({
        standing: "Company",
        present: { travel: true, uniform: true, vehicle: false },
        enteredByPerson: { travel: true, uniform: false, vehicle: false },
      }),
      "company",
    );
    expect(steps.map((s) => [s.kind, s.readOnly])).toEqual([
      ["Travel", true],
      ["Uniform", false],
      ["Vehicle", false],
      ["Review", true],
    ]);
  });

  it("never makes the person's own steps read-only", () => {
    const f = facts({
      present: { travel: true, uniform: true, vehicle: true },
      enteredByPerson: { travel: true, uniform: true, vehicle: true },
    });
    expect(
      wizardSteps(f, "person")
        .filter((s) => s.kind !== "Review")
        .every((s) => !s.readOnly),
    ).toBe(true);
  });
});

describe("status chips", () => {
  it("reads On file as complete, Missing as proposed and Not offered as deferred", () => {
    expect(chipState("onFile")).toBe("complete");
    expect(chipState("missing")).toBe("proposed");
    expect(chipState("notOffered")).toBe("deferred");
  });
});
