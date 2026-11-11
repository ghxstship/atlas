/** Fields a settings form shows before More fields (Section 11.10, Section 18 gate 27). */
export const VISIBLE_FIELDS = 7;

/**
 * Splits a settings form's fields into the ones shown and the ones under More fields, keeping
 * registry order within each. A value the org locked is always among the shown ones, so a person
 * who cannot change it reads why beside it (Section 4.5.6); it takes the place of the last
 * unlocked field that would have shown. Past seven locked values the rest sit under More fields.
 */
export function splitVisibleFields<F extends { readonly lockedByOrg: boolean }>(
  fields: readonly F[],
  visible: number = VISIBLE_FIELDS,
): { shown: F[]; more: F[] } {
  const locked = fields.filter((f) => f.lockedByOrg).slice(0, visible);
  let room = visible - locked.length;
  const show = new Set<F>(locked);
  for (const f of fields) {
    if (room === 0) break;
    if (!f.lockedByOrg) {
      show.add(f);
      room -= 1;
    }
  }
  return {
    shown: fields.filter((f) => show.has(f)),
    more: fields.filter((f) => !show.has(f)),
  };
}
