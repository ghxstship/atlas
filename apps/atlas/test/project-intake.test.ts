import { describe, expect, it } from "vitest";
import { intakeSteps, stepOfField } from "../components/projects/intake-steps";
import { narrowForm } from "../components/custom-fields/custom-field-inputs";
import type { CustomFieldForm } from "../lib/custom-fields/types";

/**
 * The staged intake (B14, G-250): which steps a choice brings, which step holds a field the action refused, and the
 * Details step's field set, with every org-required field kept so A117's required check is never hidden (ADR 0153
 * C16).
 */

describe("intake steps", () => {
  it("runs Start, Scale and audience, Basics, Details, Copy and Review for a typed copy", () => {
    expect(intakeSteps({ hasType: true, startFrom: "project" })).toEqual([
      "start",
      "bands",
      "basics",
      "details",
      "copy",
      "review",
    ]);
  });

  it("asks for bands only with an event type, and Copy only from a past project", () => {
    expect(intakeSteps({ hasType: false, startFrom: "template" })).toEqual([
      "start",
      "basics",
      "details",
      "review",
    ]);
    expect(intakeSteps({ hasType: true, startFrom: "type" })).toEqual([
      "start",
      "bands",
      "basics",
      "details",
      "review",
    ]);
  });

  it("opens the step that holds a refused field", () => {
    expect(stepOfField("key")).toBe("basics");
    expect(stepOfField("loadInTo")).toBe("basics");
    expect(stepOfField("cf.capacity")).toBe("details");
    expect(stepOfField("copyParts")).toBe("copy");
    expect(stepOfField("templateId")).toBe("start");
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
});
