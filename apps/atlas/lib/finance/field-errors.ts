import type { DataError } from "@xos/data";

/**
 * The finance catalog key (`finance.errors.fields`) for a value the database refused on one form
 * field (result.ts FIELD_CONSTRAINTS): a repeated invoice number for the same counterparty or payee
 * reads on the Invoice number field, never as someone else's concurrent save.
 */
const FIELD_ERROR_KEYS: Readonly<Record<string, string>> = { number: "numberTaken" };

/** A database refusal of one form field as its field and catalog key, or null when it is not one. */
export function fieldErrorOf(error: DataError): { field: string; key: string } | null {
  if (error.kind !== "invalid" || error.field === undefined) return null;
  const key = FIELD_ERROR_KEYS[error.field];
  return key === undefined ? null : { field: error.field, key };
}
