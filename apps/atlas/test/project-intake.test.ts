import { describe, expect, it } from "vitest";
import {
  bumpRefusalField,
  copySourceMissing,
  detailsApply,
  intakeSteps,
  stepOfField,
  submitIntake,
} from "../components/projects/intake-steps";
import {
  fieldPages,
  narrowForm,
  requiredFirst,
} from "../components/custom-fields/custom-field-inputs";
import type { CustomFieldForm } from "../lib/custom-fields/types";

/**
 * The staged intake (B14, G-250): which steps a choice brings, which step holds a field the action refused, and the
 * Details step's field set, with every org-required field kept so A117's required check is never hidden (ADR 0153
 * C16).
 */

describe("intake steps", () => {
  it("runs Start, Scale and audience, Basics, days, Details, Copy and Review for a typed copy", () => {
    expect(intakeSteps({ hasType: true, startFrom: "project", hasDetails: true })).toEqual([
      "start",
      "bands",
      "basics",
      "days",
      "details",
      "copy",
      "review",
    ]);
  });

  it("asks for bands only with an event type, and Copy only from a past project", () => {
    expect(intakeSteps({ hasType: false, startFrom: "template", hasDetails: true })).toEqual([
      "start",
      "basics",
      "days",
      "details",
      "review",
    ]);
    expect(intakeSteps({ hasType: true, startFrom: "type", hasDetails: true })).toEqual([
      "start",
      "bands",
      "basics",
      "days",
      "details",
      "review",
    ]);
  });

  it("skips Details when it has nothing to show", () => {
    expect(intakeSteps({ hasType: false, startFrom: "project", hasDetails: false })).toEqual([
      "start",
      "basics",
      "days",
      "copy",
      "review",
    ]);
    const bare = { fields: [], intakeGuidance: null };
    const none = { hasProjectFields: false, hasRequiredProjectFields: false };
    expect(detailsApply({ type: null, ...none })).toBe(false);
    expect(detailsApply({ type: null, ...none, hasProjectFields: true })).toBe(true);
    // An event type narrows the fields: an optional one outside its set does not show, a required one always does.
    expect(detailsApply({ type: bare, ...none, hasProjectFields: true })).toBe(false);
    expect(
      detailsApply({
        type: bare,
        hasProjectFields: true,
        hasRequiredProjectFields: true,
      }),
    ).toBe(true);
    expect(detailsApply({ type: { ...bare, fields: [{}] }, ...none })).toBe(true);
    expect(detailsApply({ type: { ...bare, intakeGuidance: "Bring the plan." }, ...none })).toBe(
      true,
    );
  });

  it("holds a start from a past project until the project is named", () => {
    expect(copySourceMissing("project", null)).toBe(true);
    expect(copySourceMissing("project", "9f1c2d3e-0000-4000-8000-000000000001")).toBe(false);
    expect(copySourceMissing("blank", null)).toBe(false);
    expect(copySourceMissing("", null)).toBe(false);
    expect(stepOfField("copyFromProjectId")).toBe("copy");
  });

  it("opens the step that holds a refused field", () => {
    expect(stepOfField("key")).toBe("basics");
    for (const name of ["loadInFrom", "loadInTo", "loadOutFrom", "loadOutTo"]) {
      expect(stepOfField(name)).toBe("days");
    }
    expect(stepOfField("cf.capacity")).toBe("details");
    expect(stepOfField("copyParts")).toBe("copy");
    expect(stepOfField("templateId")).toBe("start");
  });
});

describe("a refused save", () => {
  const event = () => {
    let prevented = false;
    return {
      preventDefault: () => {
        prevented = true;
      },
      prevented: () => prevented,
    };
  };

  it("moves on before the last step and goes through keepInputOnSubmit on it", () => {
    const moved: string[] = [];
    const early = event();
    submitIntake(early, {
      last: false,
      forward: () => moved.push("forward"),
      keep: () => moved.push("keep"),
    });
    expect(early.prevented()).toBe(true);
    expect(moved).toEqual(["forward"]);
    const final = event();
    submitIntake(final, {
      last: true,
      forward: () => moved.push("forward"),
      keep: () => moved.push("keep"),
    });
    expect(moved).toEqual(["forward", "keep"]);
  });

  const dates = { loadInFrom: null, loadInTo: null, loadOutFrom: null, loadOutTo: null };

  it("names the dates a bump refusal from the database is about", () => {
    expect(bumpRefusalField("project_bump_in_after_show", dates)).toBe("loadInTo");
    expect(bumpRefusalField("project_bump_out_before_show", dates)).toBe("loadOutTo");
    expect(
      bumpRefusalField("project_bump_window_bounds", { ...dates, loadInFrom: "2027-06-01" }),
    ).toBe("loadInTo");
    expect(
      bumpRefusalField("project_bump_window_bounds", { ...dates, loadOutTo: "2027-06-01" }),
    ).toBe("loadOutTo");
    expect(
      bumpRefusalField("project_bump_window_length", {
        ...dates,
        loadInFrom: "2027-01-01",
        loadInTo: "2027-03-15",
      }),
    ).toBe("loadInTo");
    expect(
      bumpRefusalField("project_bump_window_length", {
        loadInFrom: "2027-01-01",
        loadInTo: "2027-01-02",
        loadOutFrom: "2027-04-01",
        loadOutTo: "2027-08-01",
      }),
    ).toBe("loadOutTo");
    expect(bumpRefusalField("project_key_taken", dates)).toBeNull();
  });
});

describe("the Details step's fields", () => {
  const field = (key: string, required: boolean) =>
    ({
      id: key,
      table: "app.projects",
      key,
      label: key,
      dataType: "Text",
      required,
      filterable: false,
      order: 1,
      choices: [],
    }) as unknown as CustomFieldForm["fields"][number];
  const form = {
    table: "app.projects",
    targetId: null,
    fields: [field("capacity", false), field("insurer", false), field("permit", true)],
    inputs: {},
    values: {},
    people: [],
    currencies: [],
    defaultCurrency: "USD",
    timeZone: "UTC",
    canWrite: true,
  } as unknown as CustomFieldForm;

  it("shows the type's set plus every org-required field, and marks the type's required ones", () => {
    const narrowed = narrowForm(form, new Set(["capacity"]), new Set(["capacity"]));
    expect(narrowed.fields.map((f) => [f.key, f.required])).toEqual([
      ["capacity", true],
      ["permit", true],
    ]);
  });

  it("shows every field without a set", () => {
    expect(narrowForm(form, null, new Set()).fields).toHaveLength(3);
  });

  it("puts required fields first, each group in the type's order", () => {
    const fields = [field("a", false), field("b", true), field("c", false), field("d", true)];
    expect(requiredFirst(fields, ["d", "c", "b", "a"]).map((f) => f.key)).toEqual([
      "d",
      "b",
      "c",
      "a",
    ]);
    expect(requiredFirst(fields, []).map((f) => f.key)).toEqual(["b", "d", "a", "c"]);
  });

  it("pages nine fields into seven and two", () => {
    const nine = Array.from({ length: 9 }, (_, i) => field(`f${String(i)}`, false));
    expect(fieldPages(nine, 7).map((p) => p.length)).toEqual([7, 2]);
    expect(fieldPages([], 7)).toEqual([]);
  });

  it("counts a Money field's amount and currency as two visible controls", () => {
    const money = { ...field("fee", false), dataType: "Money" } as (typeof form.fields)[number];
    const six = Array.from({ length: 6 }, (_, i) => field(`f${String(i)}`, false));
    expect(fieldPages([...six, money], 7).map((p) => p.map((f) => f.key))).toEqual([
      six.map((f) => f.key),
      ["fee"],
    ]);
  });
});
