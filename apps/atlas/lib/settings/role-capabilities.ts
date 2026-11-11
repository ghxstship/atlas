/**
 * A role's capabilities grouped by their first segment (projects, finance, org...), each with the widest reach the role
 * holds it at, for Roles and Capabilities (Section 8). Codes sort within each group.
 */
export function capabilitiesByModule(
  reach: ReadonlyMap<string, string>,
): { readonly group: string; readonly capabilities: readonly (readonly [string, string])[] }[] {
  const groups = new Map<string, (readonly [string, string])[]>();
  for (const [code, r] of [...reach].sort(([a], [b]) => a.localeCompare(b))) {
    const dot = code.indexOf(".");
    const group = dot === -1 ? code : code.slice(0, dot);
    groups.set(group, [...(groups.get(group) ?? []), [code, r] as const]);
  }
  return [...groups].map(([group, capabilities]) => ({ group, capabilities }));
}
