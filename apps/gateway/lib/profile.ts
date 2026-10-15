/**
 * Profile strength (Section 11.12, Reputation: a profile strength meter that names the next
 * improvement). Each step is a profile fact the marketplace uses; the meter is the share done and
 * the next step is the first one missing, in the order that helps an application most.
 */
export interface StrengthInput {
  readonly headline: string | null;
  readonly city: string | null;
  readonly bio: string | null;
  readonly skills: number;
  readonly certifications: number;
  readonly rateMinor: number | null;
  readonly languages: number;
  readonly links: number;
  readonly availability: number;
}

export const STRENGTH_STEPS = [
  "headline",
  "skills",
  "city",
  "certifications",
  "rate",
  "availability",
  "bio",
  "languages",
  "links",
] as const;
export type StrengthStep = (typeof STRENGTH_STEPS)[number];

function done(step: StrengthStep, p: StrengthInput): boolean {
  switch (step) {
    case "headline":
      return Boolean(p.headline?.trim());
    case "skills":
      return p.skills > 0;
    case "city":
      return Boolean(p.city?.trim());
    case "certifications":
      return p.certifications > 0;
    case "rate":
      return p.rateMinor !== null;
    case "availability":
      return p.availability > 0;
    case "bio":
      return Boolean(p.bio?.trim());
    case "languages":
      return p.languages > 0;
    case "links":
      return p.links > 0;
  }
}

export function profileStrength(p: StrengthInput): { percent: number; next: StrengthStep | null } {
  const complete = STRENGTH_STEPS.filter((s) => done(s, p));
  return {
    percent: Math.round((complete.length / STRENGTH_STEPS.length) * 100),
    next: STRENGTH_STEPS.find((s) => !done(s, p)) ?? null,
  };
}
