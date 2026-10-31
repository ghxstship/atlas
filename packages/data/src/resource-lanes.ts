import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Resource lanes of the crew schedule (B4, G-43): besides one lane per person, the week by supplier and by zone.
 * Vendor lanes are one per company with live engagements on the projects in view (of any role, so vendor-supplied
 * crew counts) and one per individual Contractor engagement without a company, each with its engagement windows and
 * dock slots; the page adds the engagement's shifts. Zone lanes are the zones of the projects' venues with their dock
 * slots and work orders. Read as the caller, so row level security decides what each lane shows. Read-only.
 */

export interface LaneEngagement {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly roleType: string;
  readonly startDate: string;
  readonly endDate: string | null;
}

export interface LaneSlot {
  readonly id: string;
  readonly projectKey: string;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface VendorLane {
  readonly key: string;
  readonly label: string;
  readonly counterpartyId: string | null;
  readonly engagements: readonly LaneEngagement[];
  readonly dockSlots: readonly LaneSlot[];
}

export interface ZoneLane {
  readonly key: string;
  readonly label: string;
  readonly venueName: string;
  readonly dockSlots: readonly LaneSlot[];
  readonly workOrders: readonly LaneSlot[];
}

interface EngagementRow {
  id: string;
  project_id: string;
  counterparty_id: string | null;
  person_id: string | null;
  role_type: string;
  start_date: string;
  end_date: string | null;
  project: { project_key: string } | null;
  counterparty: { id: string; counterparty_name: string | null } | null;
  person: { full_name: string | null } | null;
}

interface SlotRow {
  id: string;
  project_id: string;
  engagement_id: string | null;
  zone_id: string;
  starts_at: string;
  ends_at: string;
  project: { project_key: string } | null;
  zone: { code: string; name: string } | null;
}

const overlaps = (startDate: string, endDate: string | null, from: string, to: string) =>
  startDate <= to && (endDate === null || endDate >= from);

/** Vendor and contractor lanes of the projects in view over [from, to] (dates), with names for each company. */
export async function listVendorLanes(
  db: XosClient,
  input: {
    readonly projectIds: readonly string[];
    readonly from: string;
    readonly to: string;
  },
): Promise<Result<VendorLane[]>> {
  if (input.projectIds.length === 0) return ok([]);
  const [engagements, slots] = await Promise.all([
    untyped(db)
      .from("engagements")
      .select(
        "id, project_id, counterparty_id, person_id, role_type, start_date, end_date, project:projects!engagements_project_id_fkey(project_key), person:people!engagements_person_id_fkey(full_name), counterparty:counterparties!engagements_counterparty_id_fkey(id, counterparty_name)",
      )
      .in("project_id", [...input.projectIds])
      .is("deleted_at", null)
      .in("engagement_state", ["Onboarding", "Blocked", "Active", "Closing"])
      .limit(1000),
    untyped(db)
      .from("dock_slots")
      .select(
        "id, project_id, engagement_id, zone_id, starts_at, ends_at, project:projects!dock_slots_project_id_fkey(project_key), zone:zones(code, name)",
      )
      .in("project_id", [...input.projectIds])
      .is("deleted_at", null)
      .not("engagement_id", "is", null)
      .lt("starts_at", `${input.to}T23:59:59Z`)
      .gt("ends_at", `${input.from}T00:00:00Z`)
      .limit(1000),
  ]);
  if (engagements.error) return fail(toDataError(engagements.error));
  if (slots.error) return fail(toDataError(slots.error));
  const lanes = new Map<
    string,
    {
      label: string;
      counterpartyId: string | null;
      engagements: LaneEngagement[];
      ids: Set<string>;
    }
  >();
  for (const e of engagements.data as unknown as EngagementRow[]) {
    const contractor = e.counterparty_id === null && e.role_type === "Contractor";
    if (e.counterparty_id === null && !contractor) continue;
    if (!overlaps(e.start_date, e.end_date, input.from, input.to)) continue;
    const key = e.counterparty_id ?? `engagement:${e.id}`;
    const lane = lanes.get(key) ?? {
      label: e.counterparty_id
        ? (e.counterparty?.counterparty_name ?? "")
        : (e.person?.full_name ?? ""),
      counterpartyId: e.counterparty_id,
      engagements: [],
      ids: new Set<string>(),
    };
    lane.engagements.push({
      id: e.id,
      projectId: e.project_id,
      projectKey: e.project?.project_key ?? "",
      roleType: e.role_type,
      startDate: e.start_date,
      endDate: e.end_date,
    });
    lane.ids.add(e.id);
    lanes.set(key, lane);
  }
  const slotRows = slots.data as unknown as SlotRow[];
  return ok(
    [...lanes]
      .map(([key, lane]) => ({
        key,
        label: lane.label,
        counterpartyId: lane.counterpartyId,
        engagements: lane.engagements,
        dockSlots: slotRows
          .filter((s) => s.engagement_id !== null && lane.ids.has(s.engagement_id))
          .map((s) => ({
            id: s.id,
            projectKey: s.project?.project_key ?? "",
            label: s.zone ? `${s.zone.code} ${s.zone.name}` : "",
            startsAt: s.starts_at,
            endsAt: s.ends_at,
          })),
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key)),
  );
}

interface ZoneRow {
  id: string;
  code: string;
  name: string;
  venue: { name: string } | null;
}

interface WorkOrderRow {
  id: string;
  title: string;
  zone_id: string | null;
  scheduled_starts_at: string | null;
  scheduled_ends_at: string | null;
  project: { project_key: string } | null;
}

/** Zone lanes: the zones of the venues of the projects in view, with the week's dock slots and work orders. */
export async function listZoneLanes(
  db: XosClient,
  input: {
    readonly projectIds: readonly string[];
    readonly venueIds: readonly string[];
    readonly from: string;
    readonly to: string;
  },
): Promise<Result<ZoneLane[]>> {
  if (input.projectIds.length === 0 || input.venueIds.length === 0) return ok([]);
  const zones = await untyped(db)
    .from("zones")
    .select("id, code, name, venue:venues(name)")
    .in("venue_id", [...input.venueIds])
    .is("deleted_at", null)
    .order("code");
  if (zones.error) return fail(toDataError(zones.error));
  const zoneRows = zones.data as unknown as ZoneRow[];
  if (zoneRows.length === 0) return ok([]);
  const zoneIds = zoneRows.map((z) => z.id);
  const [slots, orders] = await Promise.all([
    untyped(db)
      .from("dock_slots")
      .select(
        "id, project_id, engagement_id, zone_id, starts_at, ends_at, project:projects!dock_slots_project_id_fkey(project_key), zone:zones(code, name)",
      )
      .in("zone_id", zoneIds)
      .in("project_id", [...input.projectIds])
      .is("deleted_at", null)
      .lt("starts_at", `${input.to}T23:59:59Z`)
      .gt("ends_at", `${input.from}T00:00:00Z`)
      .limit(1000),
    untyped(db)
      .from("work_orders")
      .select(
        "id, title, zone_id, scheduled_starts_at, scheduled_ends_at, project:projects!work_orders_project_id_fkey(project_key)",
      )
      .in("zone_id", zoneIds)
      .in("project_id", [...input.projectIds])
      .is("deleted_at", null)
      .not("scheduled_starts_at", "is", null)
      .lt("scheduled_starts_at", `${input.to}T23:59:59Z`)
      .limit(1000),
  ]);
  if (slots.error) return fail(toDataError(slots.error));
  if (orders.error) return fail(toDataError(orders.error));
  const slotRows = slots.data as unknown as SlotRow[];
  const orderRows = (orders.data as unknown as WorkOrderRow[]).filter(
    (o) => (o.scheduled_ends_at ?? o.scheduled_starts_at ?? "") >= `${input.from}T00:00:00Z`,
  );
  return ok(
    zoneRows.map((z) => ({
      key: z.id,
      label: `${z.code} ${z.name}`,
      venueName: z.venue?.name ?? "",
      dockSlots: slotRows
        .filter((s) => s.zone_id === z.id)
        .map((s) => ({
          id: s.id,
          projectKey: s.project?.project_key ?? "",
          label: s.project?.project_key ?? "",
          startsAt: s.starts_at,
          endsAt: s.ends_at,
        })),
      workOrders: orderRows
        .filter((o) => o.zone_id === z.id)
        .map((o) => ({
          id: o.id,
          projectKey: o.project?.project_key ?? "",
          label: o.title,
          startsAt: o.scheduled_starts_at ?? "",
          endsAt: o.scheduled_ends_at ?? o.scheduled_starts_at ?? "",
        })),
    })),
  );
}

/** The venues of the given projects, for their zone lanes. */
export async function listProjectVenueIds(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<string[]>> {
  if (projectIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("projects")
    .select("venue_id")
    .in("id", [...projectIds]);
  if (error) return fail(toDataError(error));
  return ok([...new Set(data.flatMap((p) => (p.venue_id ? [p.venue_id] : [])))]);
}
