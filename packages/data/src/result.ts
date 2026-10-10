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
      /** The input failed a database check constraint. */
      readonly kind: "invalid";
      readonly message: string;
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

/** Maps a database error to a typed repository error. */
export function toDataError(error: DatabaseErrorLike): DataError {
  switch (error.code) {
    case "XR001":
      return { kind: "refusal", ...splitRefusal(error.message, error.hint) };
    case "42501":
    case "PGRST116":
      return { kind: "not-found" };
    case "23505":
      return { kind: "conflict", message: error.message };
    case "23514":
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
