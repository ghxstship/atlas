import { toDisplayKey } from "@xos/data/gateway-keys";

/**
 * The external people the sweep signs in as (supabase/seeds/0010, shared demo password): the crew
 * member holds no company account (standing `individual`) and works the seeded crew engagement; the
 * vendor contact is Account Owner of the demo vendor and works the seeded vendor engagement.
 */
export const DEMO_PASSWORD = ["xos", "demo", "2026"].join("-");

export const PEOPLE = [
  {
    person: "crew",
    email: "crew@example.com",
    standing: "individual",
    roleType: "crew",
    engagementKey: toDisplayKey("engagement", "01920000-0000-7000-8000-000000228401"),
  },
  {
    person: "vendor",
    email: "vendor@example.com",
    standing: "account-owner",
    roleType: "vendor",
    engagementKey: toDisplayKey("engagement", "01920000-0000-7000-8000-000000228402"),
  },
] as const;

export function storageStatePath(person: string): string {
  return `node_modules/.cache/a11y/gateway-${person}.json`;
}
