/**
 * Repository results. A repository function never throws for an outcome the database decides:
 * refusals (ADR 0008, SQLSTATE XR001), rows the caller may not see (42501 and empty reads, which
 * the apps show as 404 under ADR 0003) and conflicts come back as typed errors the UI can explain.
 * Transport failures and unexpected database errors come back as `unexpected` with the message, so
 * no error path is silent (Section 19.7).
 */

export type DataError =
  | {
      /** A rule refusal: the database named the rule and said why. */
      readonly kind: "refusal";
      readonly rule: string;
      readonly message: string;
    }
  | {
      /** The row does not exist or the caller may not see it; never distinguish the two. */
      readonly kind: "not-found";
    }
  | {
      /** A unique key already holds the value. */
      readonly kind: "conflict";
      readonly message: string;
    }
  | {
      /**
       * The input failed a database check constraint, named a row that does not exist (a foreign key)
       * or repeated a value a unique key holds where the form owns that value. `field` names the form
       * field at fault when the constraint maps to one (FIELD_CONSTRAINTS), so a form can say so on it.
       */
      readonly kind: "invalid";
      readonly message: string;
      readonly field?: string;
    }
  | {
      /** Anything else: network, configuration or an unexpected database error. */
      readonly kind: "unexpected";
      readonly message: string;
      readonly code?: string;
    };

export type Result<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: DataError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: DataError): Result<T> {
  return { ok: false, error };
}

/** The shape of a PostgREST or Postgres error as supabase-js reports it. */
export interface DatabaseErrorLike {
  readonly code?: string | null;
  readonly message: string;
  readonly hint?: string | null;
  readonly details?: string | null;
}

/** `<rule_code>: <sentence>` (ADR 0008, item 3) split into its parts. */
function splitRefusal(message: string, hint: string | null | undefined) {
  const separator = message.indexOf(": ");
  const prefix = separator > 0 ? message.slice(0, separator) : "";
  const rule = hint && hint.length > 0 ? hint : prefix || "refused";
  const sentence = separator > 0 && prefix === rule ? message.slice(separator + 2) : message;
  return { rule, message: sentence };
}

/**
 * Constraints whose violation is a problem with one form field, not a concurrent save or a server
 * fault. A unique key here is a value the person typed (an invoice number repeated for the same
 * counterparty or payee, 0321 and 1120), so it reads as invalid on that field instead of the
 * generic conflict; a foreign key to a canon vocabulary (every `unit_basis` references
 * xpms.dim_unit_alias) is a value outside the vocabulary.
 */
const FIELD_CONSTRAINTS: ReadonlyArray<{
  readonly code: string;
  readonly constraint: RegExp;
  readonly field: string;
}> = [
  { code: "23505", constraint: /^invoices_(person_)?number_key$/, field: "number" },
  { code: "23503", constraint: /_unit_basis_fkey$/, field: "unitBasis" },
];

/** The constraint a Postgres integrity error names in its message (`... constraint "name"`). */
function constraintOf(error: DatabaseErrorLike): string | null {
  const match = /constraint "([^"]+)"/.exec(`${error.message} ${error.details ?? ""}`);
  return match?.[1] ?? null;
}

/** The form field an integrity error is about, when its constraint maps to one. */
function fieldOf(error: DatabaseErrorLike): string | null {
  const constraint = constraintOf(error);
  if (constraint === null) return null;
  const known = FIELD_CONSTRAINTS.find(
    (c) => c.code === error.code && c.constraint.test(constraint),
  );
  return known?.field ?? null;
}

/** Maps a database error to a typed repository error. */
export function toDataError(error: DatabaseErrorLike): DataError {
  const field = error.code === "23505" || error.code === "23503" ? fieldOf(error) : null;
  if (field !== null) return { kind: "invalid", message: error.message, field };
  switch (error.code) {
    case "XR001":
      return { kind: "refusal", ...splitRefusal(error.message, error.hint) };
    case "42501":
    case "PGRST116":
      return { kind: "not-found" };
    case "23505":
      return { kind: "conflict", message: error.message };
    case "23514":
    case "23503":
    case "22023":
    case "22P02":
      return { kind: "invalid", message: error.message };
    default:
      return error.code
        ? { kind: "unexpected", message: error.message, code: error.code }
        : { kind: "unexpected", message: error.message };
  }
}

/** A refusal an RPC returned as a row (`refusal = 'REFUSE'`, `reason = <rule>`) instead of raising. */
export function rowRefusal(reason: string | null | undefined): DataError {
  const rule = reason && reason.length > 0 ? reason : "refused";
  return { kind: "refusal", rule, message: rule };
}
