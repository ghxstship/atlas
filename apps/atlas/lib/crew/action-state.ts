/** What a People or Crew server action returns to its form. Messages are already translated. */
export interface CrewActionState {
  readonly ok?: boolean;
  readonly error?: string;
  /** The refusal rule behind `error`, so a form can answer `step_up_required` with the step-up dialog. */
  readonly rule?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Where to go after success, when not back to the list. */
  readonly redirect?: string;
  /** A file the browser saves, such as a payroll export. */
  readonly file?: { readonly name: string; readonly content: string };
}
