import { DEMO } from "../support";

/**
 * The Gateway core screens (Section 18, gates 9 and 16) on the demo seed, as the seeded crew member
 * (supabase/seeds/0010), whose engagement, money and work the seed fills. The visual baselines and
 * the pseudo-locale checks visit the same list.
 */
export const PERSON = { name: "crew", email: "crew@example.com" } as const;

export interface Screen {
  /** File-safe name, used in the baseline file name. */
  readonly name: string;
  readonly path: string;
}

export const SCREENS: readonly Screen[] = [
  { name: "home", path: "/home" },
  { name: "explore", path: "/explore" },
  { name: "work", path: "/work" },
  { name: "money", path: "/money" },
  { name: "engagement", path: `/work/engagements/${DEMO.crewEngagementKey}` },
];

export const STORAGE_STATE = "node_modules/.cache/visual/gateway-crew.json";
