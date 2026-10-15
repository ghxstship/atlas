import type { ActionState } from "./actions";

/** Adds the submitted text fields to a failed action state, so the form can show them again. */
export function withEcho(form: FormData, state: ActionState): ActionState {
  if (state.ok) return state;
  const echo: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") echo[k] = v;
  return { ...state, echo };
}
