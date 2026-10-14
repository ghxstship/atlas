/**
 * Restricted fields (Section 8.3, ADR 0003): a field the caller may not read stays present as
 * `{ "masked": true, "reason": "..." }`, naming the capability that would reveal it.
 */

export interface MaskedValue {
  readonly masked: true;
  readonly reason: string;
}

export function masked(reason: string): MaskedValue {
  return { masked: true, reason };
}

export function isMasked(value: unknown): value is MaskedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as MaskedValue).masked === true &&
    typeof (value as MaskedValue).reason === "string"
  );
}

/**
 * Masks the Restricted fields of a row the caller may not read. `capabilityFor` names the
 * capability that reveals a field; `canRead` says whether the caller holds it. A field absent
 * from the row (a sparse fieldset) stays absent.
 */
export function maskRestricted<T extends Record<string, unknown>>(
  row: T,
  restricted: readonly string[],
  canRead: (field: string) => boolean,
  capabilityFor: (field: string) => string,
): T {
  const out: Record<string, unknown> = { ...row };
  for (const field of restricted) {
    if (!(field in out) || canRead(field)) continue;
    out[field] = masked(`Requires ${capabilityFor(field)}.`);
  }
  return out as T;
}
