/**
 * Canon gate criteria in the request's language (crawl 4.9: es-US showed "A budget envelope exists
 * and is approved."). xpms.dim_gate_criterion holds the English statement and no translation
 * vocabulary covers it yet, so the app catalog carries each statement under
 * `projects.gateCriteria.<gate>.<name>` (the criterion code, whose dot nests the key). A criterion
 * the catalog does not know keeps the canon English, so a statement is never missing; codes are never
 * translated.
 */
export function gateCriterionKey(criterionId: string): string {
  return `projects.gateCriteria.${criterionId}`;
}

export function localizeCriteria<T extends { readonly id: string; readonly statement: string }>(
  criteria: readonly T[],
  t: (key: string) => string,
  has: (key: string) => boolean,
): T[] {
  return criteria.map((c) => {
    const key = gateCriterionKey(c.id);
    return has(key) ? { ...c, statement: t(key) } : c;
  });
}
