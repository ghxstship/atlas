import type { DataError, Result } from "@xos/data/result";

/**
 * What a console form shows after its server action: nothing yet, done, or an error named by a catalog key under
 * the `console` namespace. Refusals name their rule (`refusals.<rule>`); the form falls back to a general sentence
 * for a rule the catalog does not know.
 */
export type ActionState =
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly at: number }
  | { readonly status: "error"; readonly key: string; readonly at: number };

export const IDLE: ActionState = { status: "idle" };

export function done(): ActionState {
  return { status: "done", at: Date.now() };
}

export function failed(key: string): ActionState {
  return { status: "error", key, at: Date.now() };
}

/** The catalog key of a repository error. */
export function errorKey(error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return error.rule === "step_up_required"
        ? "errors.step_up_required"
        : `refusals.${error.rule}`;
    case "not-found":
      return "errors.notFound";
    case "conflict":
      return "errors.conflict";
    case "invalid":
      return "errors.invalid";
    default:
      return "errors.unexpected";
  }
}

export function fromResult(result: Result<unknown>): ActionState {
  return result.ok ? done() : failed(errorKey(result.error));
}

/** A trimmed text field of a form, or an empty string. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** The days an override or flag may last, from the form's choice. */
export const EXPIRY_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;

/** The expiry instant some days from now; null for a choice outside EXPIRY_DAYS. */
export function expiryFrom(days: string, now: Date = new Date()): string | null {
  const n = Number(days);
  if (!(EXPIRY_DAYS as readonly number[]).includes(n)) return null;
  return new Date(now.getTime() + n * 86_400_000).toISOString();
}
