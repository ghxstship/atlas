/**
 * The staged intake's steps (B14, G-250): which apply, in order, and which step holds a field, so a refusal the action
 * returns opens the step to correct. Pure, for the wizard and its tests (test/project-intake.test.ts).
 */

export type IntakeStep = "start" | "bands" | "basics" | "details" | "copy" | "review";
export type StartFrom = "type" | "template" | "project" | "blank";

/** Start, Scale and audience (with an event type), Basics, Details, Copy (from a past project) and Review. */
export function intakeSteps(choice: { readonly hasType: boolean; readonly startFrom: StartFrom }): IntakeStep[] {
  return [
    "start",
    ...(choice.hasType ? (["bands"] as const) : []),
    "basics",
    "details",
    ...(choice.startFrom === "project" ? (["copy"] as const) : []),
    "review",
  ];
}

const FIELD_STEPS: Readonly<Record<string, IntakeStep>> = {
  templateId: "start",
  eventTypeId: "start",
  eventScale: "bands",
  eventAudience: "bands",
  copyFromProjectId: "copy",
  copyParts: "copy",
  copyOffsetDays: "copy",
};

/** The step that holds a form field: custom fields (`cf.<key>`) are Details, the project's own fields Basics. */
export function stepOfField(name: string): IntakeStep {
  if (name.startsWith("cf.")) return "details";
  return FIELD_STEPS[name] ?? "basics";
}
