/**
 * What one reading of "Fill from a document" keeps open (B15, ADR 0154). An invoice's lines are not
 * filled into the form: they stay open for the invoice's detail. So they are not the header, not loaded
 * one by one, and not in the form's suggestion fields, and they are rejected on Discard or when a new
 * reading replaces this one.
 */
export const DEFERRED_OPERATION = "invoiceLines.create";

/** The suggestions a reading returned, split into those the panel loads and those left open. */
export function splitReading(
  suggestions: readonly { readonly suggestion_id: string; readonly operation_id: string }[],
): { readonly loaded: readonly string[]; readonly deferred: readonly string[] } {
  return {
    loaded: suggestions
      .filter((s) => s.operation_id !== DEFERRED_OPERATION)
      .map((s) => s.suggestion_id),
    deferred: suggestions
      .filter((s) => s.operation_id === DEFERRED_OPERATION)
      .map((s) => s.suggestion_id),
  };
}

/**
 * What filling the form closes as rejected: suggestions an earlier reading filled and this one replaced,
 * that earlier reading's open lines, and lines of this reading the person left out.
 */
export function rejectedOnFill(input: {
  readonly kept: readonly string[];
  readonly filled: readonly string[];
  readonly deferred: readonly string[];
  readonly lines: readonly string[];
}): readonly string[] {
  return [
    ...input.filled.filter((s) => !input.kept.includes(s)),
    ...input.deferred,
    ...input.lines.filter((l) => !input.kept.includes(l)),
  ];
}
