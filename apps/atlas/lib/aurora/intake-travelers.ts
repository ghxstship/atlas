/** One person on the project, or one of their engagements, as the itinerary review's candidates list them. */
export interface TravelerCandidate {
  readonly person_id: string;
  readonly display_name: string;
  readonly engagement_id: string | null;
}

export interface Traveler {
  readonly value: string;
  readonly label: string;
  /** Filled only when the person has exactly one engagement on the project: two leave the segment unlinked. */
  readonly engagementId: string | null;
}

/** The people an itinerary line can go to, once each. The review offers no engagement, so it never guesses one. */
export function travelersOf(candidates: readonly TravelerCandidate[]): Traveler[] {
  const byPerson = new Map<string, { label: string; engagements: Set<string> }>();
  for (const c of candidates) {
    const known = byPerson.get(c.person_id) ?? {
      label: c.display_name,
      engagements: new Set<string>(),
    };
    if (c.engagement_id) known.engagements.add(c.engagement_id);
    byPerson.set(c.person_id, known);
  }
  return [...byPerson.entries()].map(([value, { label, engagements }]) => ({
    value,
    label,
    engagementId: engagements.size === 1 ? ([...engagements][0] ?? null) : null,
  }));
}
