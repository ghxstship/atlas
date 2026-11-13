import type { EngagementRef } from "@xos/data/settlements";

/**
 * Engagement picker options a person can tell apart (crawl 4.9: New settlement listed
 * "NWS · Demo Crew Member · Staff" four times). Each reads project, party and role, then the start
 * day and any state other than Active; a Canceled engagement is left out, since it takes no new
 * settlement. Options that still read the same are numbered, newest first as listed.
 */
export function engagementOptions(
  refs: readonly EngagementRef[],
  word: {
    readonly projectKey: (projectId: string) => string;
    readonly party: (ref: EngagementRef) => string;
    readonly role: (roleType: string) => string;
    readonly state: (state: string) => string;
    readonly day: (isoDate: string) => string;
    readonly numbered: (label: string, n: number) => string;
  },
): { value: string; label: string }[] {
  const labels = refs
    .filter((e) => e.state !== "Canceled")
    .map((e) => ({
      value: e.id,
      label: [
        word.projectKey(e.projectId),
        word.party(e),
        word.role(e.roleType),
        ...(e.startDate ? [word.day(e.startDate)] : []),
        ...(e.state !== "Active" ? [word.state(e.state)] : []),
      ]
        .filter((part) => part !== "")
        .join(" · "),
    }));
  const total = new Map<string, number>();
  for (const o of labels) total.set(o.label, (total.get(o.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.map((o) => {
    if ((total.get(o.label) ?? 0) < 2) return o;
    const n = (seen.get(o.label) ?? 0) + 1;
    seen.set(o.label, n);
    return { value: o.value, label: word.numbered(o.label, n) };
  });
}
