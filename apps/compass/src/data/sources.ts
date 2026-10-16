/**
 * Where each local table comes from, per audience (Section 8.7: external reads go through the
 * column-allowlisted api_external views; internal reads go through the app tables under RLS).
 *
 * PowerSync streams these when the PowerSync service is configured (packages/sync/sync-rules.yaml); without
 * it, the REST downloader pulls the same sources. Either way every row passes the device-side scope check
 * in SyncSession before it is stored.
 */
import { isInternal, type Audience } from "@xos/sync";

export interface Source {
  /** Local table name (the scope rules in packages/sync key on it). */
  readonly table: string;
  readonly schema: "app" | "api_external" | "xpms";
  readonly relation: string;
  readonly select: string;
  /** Column holding the project id, to limit a pull to the current project. */
  readonly projectColumn?: string;
  /** Maps a downloaded row to the local row shape, for views whose columns differ. */
  readonly map?: (row: Record<string, unknown>) => Record<string, unknown>;
}

const INTERNAL_SOURCES: readonly Source[] = [
  {
    table: "projects",
    schema: "app",
    relation: "projects",
    select: "id,org_id,name,time_zone",
    projectColumn: "id",
  },
  {
    table: "shifts",
    schema: "app",
    relation: "shifts",
    select:
      "id,org_id,project_id,membership_id,engagement_id,role_code,starts_at,ends_at,time_zone,shift_state,scope_node_id",
    projectColumn: "project_id",
  },
  {
    table: "clock_punches",
    schema: "app",
    relation: "clock_punches",
    select:
      "id,org_id,project_id,membership_id,engagement_id,shift_id,punch_kind,device_time,effective_at,source,geofence_verified,skew_flagged",
    projectColumn: "project_id",
  },
  {
    table: "time_entries",
    schema: "app",
    relation: "time_entries",
    select:
      "id,org_id,project_id,membership_id,engagement_id,shift_id,clock_in,clock_out,break_minutes,needs_review,auto_closed_at",
    projectColumn: "project_id",
  },
  {
    table: "geofence_shapes",
    schema: "app",
    relation: "geofence_shapes",
    select: "id,venue_id,zone_id,name,boundary_geojson",
  },
  {
    table: "day_sheets",
    schema: "app",
    relation: "day_sheets",
    select: "id,org_id,project_id,day,body",
    projectColumn: "project_id",
  },
  {
    table: "run_of_show",
    schema: "app",
    relation: "run_of_show",
    select: "id,org_id,project_id,name,show_date",
    projectColumn: "project_id",
  },
  {
    table: "cues",
    schema: "app",
    relation: "cues",
    select: "id,org_id,project_id,run_of_show_id,position,label,planned_at,duration,called_at",
    projectColumn: "project_id",
  },
  {
    table: "incidents",
    schema: "app",
    relation: "incidents",
    select:
      "id,org_id,project_id,incident_number,title,severity_enum_id,zone_id,occurred_at,reported_by,incident_state",
    projectColumn: "project_id",
  },
  {
    table: "inspection_templates",
    schema: "app",
    relation: "inspection_templates",
    select: "id,org_id,name",
  },
  {
    table: "inspection_items",
    schema: "app",
    relation: "inspection_items",
    select: "id,org_id,inspection_template_id,position,prompt,is_critical",
  },
  {
    table: "inspections",
    schema: "app",
    relation: "inspections",
    select:
      "id,org_id,project_id,inspection_template_id,inspector_person_id,inspected_at,signed_off_by,signed_off_at",
    projectColumn: "project_id",
  },
  {
    table: "credentials",
    schema: "app",
    relation: "credentials",
    select:
      "id,org_id,project_id,credential_category_id,holder_person_id,credential_number,valid_from,valid_to,revoked_at,engagement_id",
    projectColumn: "project_id",
  },
  {
    table: "access_grid",
    schema: "app",
    relation: "access_grid",
    select: "id,org_id,project_id,credential_category_id,zone_id,window_starts_at,window_ends_at",
    projectColumn: "project_id",
  },
  {
    table: "radio_channels",
    schema: "app",
    relation: "radio_channels",
    select: "id,org_id,project_id,channel_number,name,zone_id",
    projectColumn: "project_id",
  },
  {
    table: "sops",
    schema: "app",
    relation: "sops",
    select: "id,org_id,code,title,body,version,published_at",
  },
  { table: "zones", schema: "app", relation: "zones", select: "id,org_id,venue_id,code,name" },
  {
    table: "dock_slots",
    schema: "app",
    relation: "dock_slots",
    select:
      "id,org_id,project_id,zone_id,shipment_id,starts_at,ends_at,checked_in_at,engagement_id",
    projectColumn: "project_id",
  },
  {
    table: "gate_queue",
    schema: "app",
    relation: "gate_queue",
    select: "id,org_id,project_id,shipment_id,vehicle_identifier,arrived_at,released_at",
    projectColumn: "project_id",
  },
  {
    table: "marshalling_log",
    schema: "app",
    relation: "marshalling_log",
    select: "id,org_id,project_id,shipment_id,zone_id,entry,logged_at",
    projectColumn: "project_id",
  },
  {
    table: "fulfillments",
    schema: "app",
    relation: "fulfillments",
    select: "id,org_id,project_id,fulfillment_kind,title,starts_at,fulfillment_state",
    projectColumn: "project_id",
  },
  {
    // The kiosk roster: org members by name, for the shared clock-in picker (Section 4.3 item 2).
    table: "kiosk_roster",
    schema: "app",
    relation: "memberships",
    select: "id,org_id,people(full_name)",
    map: (r) => ({
      id: r["id"],
      org_id: r["org_id"],
      display_name: (r["people"] as { full_name?: string | null } | null)?.full_name ?? "",
    }),
  },
  {
    table: "asset_units",
    schema: "app",
    relation: "asset_units",
    select: "id,org_id,asset_class_id,asset_tag,asset_state",
  },
  {
    table: "asset_identifiers",
    schema: "app",
    relation: "asset_identifiers",
    select: "id,org_id,asset_unit_id,scheme,value",
  },
  {
    table: "asset_custody",
    schema: "app",
    relation: "asset_custody",
    select:
      "id,org_id,asset_unit_id,custodian_membership_id,custodian_engagement_id,project_id,venue_id,created_at",
  },
];

const EXTERNAL_SOURCES: readonly Source[] = [
  {
    table: "projects",
    schema: "api_external",
    relation: "projects",
    select: "id,org_id,name,time_zone",
    projectColumn: "id",
  },
  {
    table: "clock_punches",
    schema: "api_external",
    relation: "clock_punches",
    select:
      "id,engagement_id,project_id,shift_id,punch_kind,device_time,effective_at,source,geofence_verified,skew_flagged",
    projectColumn: "project_id",
  },
  {
    table: "radio_channels",
    schema: "api_external",
    relation: "radio_channels",
    select: "id,project_id,channel_number,name,zone_id",
    projectColumn: "project_id",
  },
  {
    // The gear the person's engagements hold now; the view's names map back to the table's.
    table: "asset_custody",
    schema: "api_external",
    relation: "asset_custody",
    select: "id,asset_unit_id,engagement_id,project_id,held_since",
    map: (r) => ({
      id: r["id"],
      asset_unit_id: r["asset_unit_id"],
      custodian_engagement_id: r["engagement_id"],
      project_id: r["project_id"],
      created_at: r["held_since"],
    }),
  },
  {
    table: "shifts",
    schema: "api_external",
    relation: "shifts",
    select:
      "id,engagement_id,project_id,project_name,role_code,job_title,starts_at,ends_at,time_zone,shift_state",
    projectColumn: "project_id",
  },
  {
    table: "time_entries",
    schema: "api_external",
    relation: "time_entries",
    select: "id,engagement_id,project_id,shift_id,clock_in,clock_out,break_minutes",
    projectColumn: "project_id",
  },
  {
    table: "day_sheets",
    schema: "api_external",
    relation: "day_sheets",
    select: "id,project_id,project_name,day,body",
    projectColumn: "project_id",
  },
  {
    table: "run_of_show",
    schema: "api_external",
    relation: "run_of_show",
    select: "id,project_id,project_name,name,show_date",
    projectColumn: "project_id",
  },
  {
    table: "cues",
    schema: "api_external",
    relation: "cues",
    select: "id,run_of_show_id,position,label,planned_at,duration,called_at,is_my_set",
  },
  {
    table: "credentials",
    schema: "api_external",
    relation: "credentials",
    select:
      "id,project_id,project_name,category_code,category_name,holder_person_id,holder_name,credential_number,valid_from,valid_to,revoked_at",
    projectColumn: "project_id",
  },
  {
    table: "dock_slots",
    schema: "api_external",
    relation: "dock_slots",
    select:
      "id,project_id,project_name,zone_code,zone_name,shipment_id,direction,tracking_identifier,starts_at,ends_at",
    projectColumn: "project_id",
  },
];

/** Canon reference rows every device caches for offline use (Section 13: reference available offline). */
const CANON_SOURCES: readonly Source[] = [
  {
    table: "emergency_codes",
    schema: "xpms",
    relation: "emergency_code",
    select: "*",
    map: (r) => ({ ...r, id: r["code"] }),
  },
  {
    table: "incident_severities",
    schema: "xpms",
    relation: "std_enumeration",
    select: "record_id,enum_code,enum_label,sort_order,color_code,enum_domain",
    map: (r) => ({
      id: r["record_id"],
      code: r["enum_code"],
      label: r["enum_label"],
      sortOrder: Number(r["sort_order"]),
      colorCode: r["color_code"],
    }),
  },
  {
    table: "inspection_result_values",
    schema: "xpms",
    relation: "std_enumeration",
    select: "record_id,enum_code,enum_label,sort_order,enum_domain",
    map: (r) => ({
      id: r["record_id"],
      code: r["enum_code"],
      label: r["enum_label"],
      sortOrder: Number(r["sort_order"]),
    }),
  },
];

/** Canon enumeration domain each canon table filters on. */
export const CANON_DOMAIN: Readonly<Record<string, string>> = {
  incident_severities: "Incident Severity",
  inspection_result_values: "Inspection Result",
};

export function sourcesFor(audience: Audience): readonly Source[] {
  return [...(isInternal(audience) ? INTERNAL_SOURCES : EXTERNAL_SOURCES), ...CANON_SOURCES];
}

/** Local rows keyed by id; a mapped row without an id is dropped rather than stored under a bad key. */
export function toLocalRows(
  source: Source,
  rows: readonly Record<string, unknown>[],
): { id: string }[] {
  const out: { id: string }[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = source.map ? source.map(raw) : raw;
    const id = row["id"];
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...row, id });
  }
  return out;
}
