import type { Engagement, ExternalRow, SharedRecord } from "@xos/data/gateway";

/**
 * Work, Upcoming (Section 4.5.8): every dated thing across orgs in one time-ordered list: shifts,
 * shared records (set times, load-ins, deadlines), dock slots, lodging, interviews and the first
 * day of each engagement. Pure, so the merge and order are testable.
 */
export interface UpcomingItem {
  readonly id: string;
  readonly kind: "shift" | "record" | "dock" | "lodging" | "interview" | "start";
  readonly title: string;
  readonly at: string;
  readonly endsAt: string | null;
  readonly timeZone: string | null;
  readonly orgName: string | null;
  readonly projectName: string | null;
  /** The engagement the item belongs to, for its link. */
  readonly engagementKey: string | null;
  /** A record kind or state label key, when the item has one. */
  readonly detail: string | null;
}

export function mergeUpcoming(input: {
  readonly now: Date;
  readonly engagements: readonly Engagement[];
  readonly shifts: readonly ExternalRow<"shifts">[];
  readonly records: readonly SharedRecord[];
  readonly docks: readonly ExternalRow<"dock_slots">[];
  readonly lodging: readonly ExternalRow<"lodging">[];
  readonly interviews: readonly { id: string; title: string; orgName: string | null; at: string }[];
}): UpcomingItem[] {
  const at = input.now.toISOString();
  const today = at.slice(0, 10);
  const byEngagement = new Map(input.engagements.map((e) => [e.id, e]));
  const byProject = new Map(input.engagements.map((e) => [e.projectId, e]));
  const items: UpcomingItem[] = [];
  for (const s of input.shifts) {
    if (!s.id || !s.starts_at || s.shift_state === "Canceled") continue;
    const e = s.engagement_id ? byEngagement.get(s.engagement_id) : undefined;
    items.push({
      id: `shift-${s.id}`,
      kind: "shift",
      title: s.job_title ?? s.scope_node_name ?? "",
      at: s.starts_at,
      endsAt: s.ends_at,
      timeZone: s.time_zone,
      orgName: e?.orgName ?? null,
      projectName: s.project_name,
      engagementKey: e?.key ?? null,
      detail: s.shift_state ? `shiftState:${s.shift_state}` : null,
    });
  }
  for (const r of input.records) {
    const start = r.startsAt ?? r.dueAt;
    if (!start || r.kind === "Shift") continue;
    const e = byProject.get(r.projectId);
    items.push({
      id: `record-${r.id}`,
      kind: "record",
      title: r.title,
      at: start,
      endsAt: r.endsAt,
      timeZone: r.timeZone,
      orgName: e?.orgName ?? null,
      projectName: e?.projectName ?? null,
      engagementKey: e?.key ?? null,
      detail: `recordKind:${r.kind}`,
    });
  }
  for (const d of input.docks) {
    if (!d.id || !d.starts_at) continue;
    const e = d.engagement_id ? byEngagement.get(d.engagement_id) : undefined;
    items.push({
      id: `dock-${d.id}`,
      kind: "dock",
      title: d.zone_name ?? d.tracking_identifier ?? "",
      at: d.starts_at,
      endsAt: d.ends_at,
      timeZone: null,
      orgName: e?.orgName ?? null,
      projectName: d.project_name,
      engagementKey: e?.key ?? null,
      detail: d.direction ? `shipmentDirection:${d.direction}` : null,
    });
  }
  for (const l of input.lodging) {
    if (!l.id || !l.check_in_on) continue;
    const e = l.project_id ? byProject.get(l.project_id) : undefined;
    items.push({
      id: `lodging-${l.id}`,
      kind: "lodging",
      title: l.hotel_name ?? l.block_title ?? "",
      at: l.check_in_on,
      endsAt: l.check_out_on,
      timeZone: null,
      orgName: e?.orgName ?? null,
      projectName: l.project_name,
      engagementKey: e?.key ?? null,
      detail: null,
    });
  }
  for (const i of input.interviews) {
    items.push({
      id: `interview-${i.id}`,
      kind: "interview",
      title: i.title,
      at: i.at,
      endsAt: null,
      timeZone: null,
      orgName: i.orgName,
      projectName: null,
      engagementKey: null,
      detail: null,
    });
  }
  for (const e of input.engagements) {
    if (e.state === "Canceled" || e.state === "Complete") continue;
    items.push({
      id: `start-${e.id}`,
      kind: "start",
      title: e.jobTitle,
      at: e.startDate,
      endsAt: e.endDate,
      timeZone: null,
      orgName: e.orgName,
      projectName: e.projectName,
      engagementKey: e.key,
      detail: `engagementState:${e.state}`,
    });
  }
  return items
    .filter((i) => (i.endsAt ?? i.at) >= (i.at.length === 10 ? today : at))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Items grouped by calendar date (UTC date of the start). */
export function byDay(items: readonly UpcomingItem[]): [string, UpcomingItem[]][] {
  const groups = new Map<string, UpcomingItem[]>();
  for (const item of items) {
    const day = item.at.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return [...groups];
}
