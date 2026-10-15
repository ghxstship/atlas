import type { DataError } from "@xos/data";

/**
 * Shared shapes and parsing for the procurement, vendor, knowledge and canon pages (A16). Server
 * actions return an ActionState; forms show its copy keys (under `procurement.kit` and each
 * module's `refusals`) and never the raw database message, so every outcome reads in en-US and
 * es-US. Money is typed as a decimal and stored in integer minor units; blank stays NULL
 * (unpriced), never zero.
 */

export interface ActionState {
  readonly ok?: boolean;
  /** Id of the row the action created, for opening its peek. */
  readonly id?: string;
  /** A refusal rule the database named, shown from the refusal catalog. */
  readonly rule?: string;
  /** A kit error key: notFound, conflict, invalid, unexpected, approvalPending. */
  readonly error?: string;
  /** Field name to kit validation key. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

export const INITIAL_ACTION_STATE: ActionState = {};

/** Maps a repository error to an action state the form can explain. */
export function fromDataError(error: DataError): ActionState {
  switch (error.kind) {
    case "refusal":
      return { rule: error.rule };
    case "not-found":
      return { error: "notFound" };
    case "conflict":
      return { error: error.message === "sop_edited_elsewhere" ? "editedElsewhere" : "conflict" };
    case "invalid":
      return { error: "invalid" };
    default:
      return { error: "unexpected" };
  }
}

/**
 * The catalog key for a refusal rule: the rule itself when the module catalog names it, otherwise
 * the lifecycle families every state machine shares, otherwise the generic refusal.
 */
export function refusalKey(rule: string, known: ReadonlySet<string>): string {
  if (known.has(rule)) return rule;
  if (rule.endsWith("_transition_not_allowed")) return "transition_not_allowed";
  if (rule.endsWith("_state_conflict")) return "state_conflict";
  if (rule.startsWith("sod_")) return "separation_of_duties";
  return "refused";
}

/** A text field: trimmed, or null when blank. */
export function text(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A required text field within a length; null when missing or out of range. */
export function requiredText(form: FormData, name: string, max = 500): string | null {
  const value = text(form, name);
  return value !== null && value.length <= max ? value : null;
}

/** A decimal number field; `undefined` when malformed, null when blank. */
export function decimal(form: FormData, name: string): number | null | undefined {
  const value = text(form, name);
  if (value === null) return null;
  const normalized = value.replace(/,/g, "");
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(normalized)) return undefined;
  return Number(normalized);
}

/** A whole number field within bounds; `undefined` when malformed or out of bounds, null when blank. */
export function integer(
  form: FormData,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number | null | undefined {
  const value = decimal(form, name);
  if (value === null || value === undefined) return value;
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Parses a typed money amount ("1,250.50") into integer minor units of a currency with the given
 * exponent. Blank is null (unpriced); malformed or too precise is `undefined`.
 */
export function moneyToMinor(raw: string | null, exponent = 2): number | null | undefined {
  if (raw === null) return null;
  const value = raw.trim().replace(/,/g, "");
  if (value === "") return null;
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (!match) return undefined;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > exponent) return undefined;
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  if (!Number.isSafeInteger(minor)) return undefined;
  return sign === "-" ? -minor : minor;
}

/** Minor units back to the decimal a person types, for editing; null becomes blank. */
export function minorToInput(minor: number | null, exponent = 2): string {
  if (minor === null) return "";
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const scale = 10 ** exponent;
  const whole = Math.floor(abs / scale);
  const fraction = exponent > 0 ? `.${String(abs % scale).padStart(exponent, "0")}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** A date field as YYYY-MM-DD; `undefined` when malformed, null when blank. */
export function isoDate(form: FormData, name: string): string | null | undefined {
  const value = text(form, name);
  if (value === null) return null;
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/** A datetime-local field as an ISO instant; `undefined` when malformed, null when blank. */
export function isoInstant(form: FormData, name: string): string | null | undefined {
  const value = text(form, name);
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** A UUID field; null when missing or malformed. */
export function uuid(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value !== null && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/** Every value of a repeated field (checkbox groups, multi-selects). */
export function all(form: FormData, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");
}

/** Collects field errors; empty means valid. */
export class FieldErrors {
  private readonly errors: Record<string, string> = {};
  add(field: string, key: string): void {
    this.errors[field] ??= key;
  }
  /** Records `key` for `field` when the value is null or undefined and returns the value. */
  need<T>(field: string, value: T | null | undefined, key = "required"): T | null {
    if (value === null || value === undefined) {
      this.add(field, key);
      return null;
    }
    return value;
  }
  get any(): boolean {
    return Object.keys(this.errors).length > 0;
  }
  get state(): ActionState {
    return { fieldErrors: { ...this.errors } };
  }
}
