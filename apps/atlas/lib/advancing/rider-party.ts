/**
 * 'Whose rider' on Atlas Advancing Riders (R2): a rider names nobody, a counterparty ("c:<id>") or an
 * individual artist's engagement ("e:<id>"). The select is native and uncontrolled, so a value with
 * no matching option falls back to the first one, "No one yet"; these keep the rider's own party
 * offered and limit Artist engagements to the project in hand.
 */

export interface PartyChoice {
  readonly value: string;
  readonly label: string;
  /** The project an Artist engagement belongs to; counterparties have none. */
  readonly projectId?: string;
}

/** The select value of a rider's party: "", "c:<counterparty id>" or "e:<engagement id>". */
export function riderPartyValue(r: {
  readonly counterpartyId: string | null;
  readonly engagementId: string | null;
}): string {
  if (r.engagementId) return `e:${r.engagementId}`;
  return r.counterpartyId ? `c:${r.counterpartyId}` : "";
}

/**
 * The choices for a rider on one project: every counterparty, the Artist engagements of that
 * project, and the rider's current party when the picker left it out (an engagement that has ended,
 * or an editor without a people-picker capability).
 */
export function riderPartyChoices(
  parties: readonly PartyChoice[],
  projectId: string,
  current: { readonly value: string; readonly label: string } | null = null,
): { value: string; label: string }[] {
  const choices = parties
    .filter((p) => p.projectId === undefined || p.projectId === projectId)
    .map((p) => ({ value: p.value, label: p.label }));
  if (current && current.value !== "" && !choices.some((c) => c.value === current.value))
    choices.push({ value: current.value, label: current.label });
  return choices;
}
