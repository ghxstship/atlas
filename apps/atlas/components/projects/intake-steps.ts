/**
 * The staged intake's steps (B14, G-250): which apply, in order, and which step holds a field, so a refusal the action
 * returns opens the step to correct. Pure, for the wizard and its tests (test/project-intake.test.ts).
 */

export type IntakeStep = "start" | "bands" | "basics" | "days" | "details" | "copy" | "review";
export type StartFrom = "type" | "template" | "project" | "blank";

/**
 * Start, Scale and audience (with an event type), Basics, Load-in and load-out, Details (when it has anything to show),
 * Copy (from a past project) and Review.
 */
export function intakeSteps(choice: {
  readonly hasType: boolean;
  readonly startFrom: StartFrom;
  readonly hasDetails: boolean;
}): IntakeStep[] {
  return [
    "start",
    ...(choice.hasType ? (["bands"] as const) : []),
    "basics",
    "days",
    ...(choice.hasDetails ? (["details"] as const) : []),
    ...(choice.startFrom === "project" ? (["copy"] as const) : []),
    "review",
  ];
}

/**
 * Whether the Details step has anything to show. With an event type, the type's own fields, its guidance or a field the
 * org requires of every project (shown whatever the type); without one, any project field.
 */
export function detailsApply(input: {
  readonly type: {
    readonly fields: readonly unknown[];
    readonly intakeGuidance: string | null;
  } | null;
  readonly hasProjectFields: boolean;
  readonly hasRequiredProjectFields: boolean;
}): boolean {
  if (!input.type) return input.hasProjectFields;
  return (
    input.type.fields.length > 0 ||
    Boolean(input.type.intakeGuidance) ||
    input.hasRequiredProjectFields
  );
}

/** A start from a past project names the project: without one nothing is copied, and Review says it would be. */
export function copySourceMissing(startFrom: string, copyFromProjectId: string | null): boolean {
  return startFrom === "project" && copyFromProjectId === null;
}

const FIELD_STEPS: Readonly<Record<string, IntakeStep>> = {
  templateId: "start",
  eventTypeId: "start",
  eventScale: "bands",
  eventAudience: "bands",
  loadInFrom: "days",
  loadInTo: "days",
  loadOutFrom: "days",
  loadOutTo: "days",
  copyFromProjectId: "copy",
  copyParts: "copy",
  copyOffsetDays: "copy",
};

/** The step that holds a form field: custom fields (`cf.<key>`) are Details, the project's own fields Basics. */
export function stepOfField(name: string): IntakeStep {
  if (name.startsWith("cf.")) return "details";
  return FIELD_STEPS[name] ?? "basics";
}

/**
 * The wizard's form submit: Enter moves to the next step until the last one, and the last goes through `keep`
 * (collection-kit's keepInputOnSubmit), because React resets a form's uncontrolled fields after a plain form action and a
 * refused save must keep what was typed.
 */
export function submitIntake<E extends { preventDefault(): void }>(
  event: E,
  step: { readonly last: boolean; readonly forward: () => void; readonly keep: (event: E) => void },
): void {
  if (step.last) {
    step.keep(event);
    return;
  }
  event.preventDefault();
  step.forward();
}

/** The dates a bump-window refusal is about, as the wizard posted them. */
export interface BumpDates {
  readonly loadInFrom: string | null;
  readonly loadInTo: string | null;
  readonly loadOutFrom: string | null;
  readonly loadOutTo: string | null;
}

const DAY_MS = 86_400_000;
const span = (from: string | null, to: string | null) =>
  from && to ? (Date.parse(to) - Date.parse(from)) / DAY_MS + 1 : 0;

/**
 * The field that holds a bump-window refusal only the database could make (app.create_project_from_intake): a template's
 * last show day, say, is unknown to the form. Without a field error the wizard would stay on Review.
 */
export function bumpRefusalField(rule: string, dates: BumpDates): "loadInTo" | "loadOutTo" | null {
  switch (rule) {
    case "project_bump_in_after_show":
      return "loadInTo";
    case "project_bump_out_before_show":
      return "loadOutTo";
    case "project_bump_window_bounds":
      return (dates.loadInFrom === null) !== (dates.loadInTo === null) ||
        (dates.loadInTo ?? "") < (dates.loadInFrom ?? "")
        ? "loadInTo"
        : "loadOutTo";
    case "project_bump_window_length":
      return span(dates.loadInFrom, dates.loadInTo) > 60 ? "loadInTo" : "loadOutTo";
    default:
      return null;
  }
}
