import { dateIn } from "@xos/data/calendar";

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

/**
 * Where each step is fixed (A65-031: the meter shows what is missing and links to it): the field or
 * section on Settings, Profile, or the availability calendar on the profile page.
 */
export const STRENGTH_LINKS: Readonly<Record<StrengthStep, string>> = {
  headline: "/settings/profile#profile-headline",
  skills: "/settings/profile#skills",
  city: "/settings/profile#profile-city",
  certifications: "/settings/profile#certifications",
  rate: "/settings/profile#profile-rate",
  availability: "/profile#availability",
  bio: "/settings/profile#about",
  languages: "/settings/profile#languages",
  links: "/settings/profile#links",
};

export function profileStrength(p: StrengthInput): {
  percent: number;
  next: StrengthStep | null;
  /** Every step still missing, in the order that helps an application most. */
  missing: StrengthStep[];
} {
  const complete = STRENGTH_STEPS.filter((s) => done(s, p));
  const missing = STRENGTH_STEPS.filter((s) => !done(s, p));
  return {
    percent: Math.round((complete.length / STRENGTH_STEPS.length) * 100),
    next: missing[0] ?? null,
    missing,
  };
}

/** An availability block as the profile reads it: its calendar and its bounds (ends exclusive). */
export interface AvailabilityBlockDays {
  readonly calendarId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: string;
}

/**
 * The first and last day a block covers, as ISO dates on its calendar's zone (`zones` by calendar id, UTC when
 * absent). A block runs from a day's midnight to the next day's midnight in that zone, as an availability poll
 * answer is written (6123), so reading its instants as UTC days moves it a day early east of Greenwich.
 */
export function blockRange(
  block: AvailabilityBlockDays,
  zones: ReadonlyMap<string, string>,
): { first: string; last: string } {
  const zone = zones.get(block.calendarId) ?? "UTC";
  const first = dateIn(new Date(block.startsAt), zone);
  // The end is exclusive: the last day is the one holding the instant before it.
  const last = dateIn(new Date(Date.parse(block.endsAt) - 1), zone);
  return { first, last: last < first ? first : last };
}

/** Days from blocks of one kind, as ISO dates on each block's calendar, for the availability calendar. */
export function blockDays(
  blocks: readonly AvailabilityBlockDays[],
  kind: string,
  zones: ReadonlyMap<string, string>,
): string[] {
  const days: string[] = [];
  for (const b of blocks.filter((x) => x.kind === kind)) {
    const { first, last } = blockRange(b, zones);
    for (
      let at = Date.parse(`${first}T00:00:00Z`);
      at <= Date.parse(`${last}T00:00:00Z`) && days.length < 400;
      at += 86_400_000
    ) {
      days.push(new Date(at).toISOString().slice(0, 10));
    }
  }
  return days;
}
