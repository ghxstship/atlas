import { DEMO_ORG } from "../a11y/roles";

/**
 * The Atlas core screens (Section 18, gates 9 and 16) on the demo seed. The visual baselines and the
 * pseudo-locale checks visit the same list. Settings belong to the owner; every other screen is the
 * producer's, whose Inbox and My Work the seed fills.
 */
export const PEOPLE = {
  producer: "producer@example.com",
  owner: "owner@example.com",
} as const;

export type Person = keyof typeof PEOPLE;

export interface Screen {
  /** File-safe name, used in the baseline file name. */
  readonly name: string;
  readonly path: string;
  readonly person: Person;
}

export const SCREENS: readonly Screen[] = [
  { name: "home", path: `/${DEMO_ORG}/home`, person: "producer" },
  { name: "projects", path: `/${DEMO_ORG}/projects`, person: "producer" },
  { name: "project-overview", path: `/${DEMO_ORG}/p/NWS/overview`, person: "producer" },
  { name: "inbox", path: `/${DEMO_ORG}/inbox`, person: "producer" },
  { name: "my-work", path: `/${DEMO_ORG}/my-work`, person: "producer" },
  // The table view: the default resource schedule shows the current week, whose columns move with
  // the calendar while the seeded shifts do not.
  { name: "crew-shifts", path: `/${DEMO_ORG}/crew/shifts?view=table`, person: "producer" },
  { name: "finance-budgets", path: `/${DEMO_ORG}/finance/budgets`, person: "producer" },
  { name: "record", path: `/${DEMO_ORG}/r/NWS-12`, person: "producer" },
  { name: "settings-general", path: `/${DEMO_ORG}/settings/general`, person: "owner" },
];

export function storageStatePath(person: string): string {
  return `node_modules/.cache/visual/atlas-${person}.json`;
}
