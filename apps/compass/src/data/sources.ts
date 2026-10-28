/**
 * Where each local table comes from, per audience (Section 8.7: external reads go through the
 * column-allowlisted api_external views; internal reads go through the app tables under RLS). The person's
 * own certifications and documents come from api_external views that return only their rows, whatever their
 * audience (A109).
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
  /** Column holding a person id: the pull asks only for the signed-in person's own rows (A92). */
  readonly personColumn?: string;
  /** External role types that read the source; omitted means every audience of its list (A92). */
  readonly audiences?: readonly Audience[];
  /**
   * A child row (a purchase order line) takes its project from its parent's local row, pulled earlier in the same
   * download, so the device-side scope check can place it (A92); `column` holds the parent's id.
   */
  readonly parent?: { readonly table: string; readonly column: string };
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
    select: "id,org_id,venue_id,zone_id,name,boundary_geojson",
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
    // The org's own emergency codes (WP18, 1612): its copy of each canon code, relabeled and reordered. A removed
    // code is kept on the server so adopting the Standard Library again never brings it back; the device drops it.
    table: "emergency_codes",
    schema: "app",
    relation: "emergency_codes",
    select: "id,org_id,code,label,emergency,sort_order,deleted_at",
    map: (r) => (r["deleted_at"] ? {} : { ...r, sort_order: Number(r["sort_order"]) }),
  },
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
    select: "id,org_id,people:people!memberships_person_id_fkey(full_name)",
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
    select: "id,org_id,asset_class_id,asset_tag,asset_state,updated_at",
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
  {
    // Expenses (Section 4.3 item 11, A92): the lines a person may post to, with no amounts, so the picker works
    // offline. app.expense_budget_lines (1622) keeps them to projects where the person records expenses, which a
    // field crew member does without reading the budget (ADR 0033 decision 76).
    table: "budget_lines",
    schema: "app",
    relation: "expense_budget_lines",
    select:
      "id,org_id,project_id,budget_name,currency_code,is_baseline,line_number,description,urid",
    map: (r) => ({
      id: r["id"],
      org_id: r["org_id"],
      project_id: r["project_id"],
      budget_name: r["budget_name"] ?? "",
      currency_code: r["currency_code"],
      is_baseline: r["is_baseline"] === true,
      line_number: Number(r["line_number"]),
      description: r["description"],
      urid: r["urid"] ?? null,
    }),
  },
  {
    // The person's own expenses: they read every expense they submitted (0321), whatever else they may read.
    table: "expenses",
    schema: "app",
    relation: "expenses",
    select:
      "id,org_id,budget_line_id,submitter_person_id,description,incurred_on,amount_minor,currency_code,expense_state,created_at,deleted_at",
    personColumn: "submitter_person_id",
    map: (r) => (r["deleted_at"] ? {} : { ...r, amount_minor: Number(r["amount_minor"]) }),
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
    select: "id,engagement_id,project_id,shift_id,clock_in,clock_out,break_minutes,source",
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
    // External cues carry no project; it comes from their running order.
    parent: { table: "run_of_show", column: "run_of_show_id" },
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
      "id,project_id,project_name,zone_code,zone_name,shipment_id,direction,tracking_identifier,starts_at,ends_at,engagement_id",
    projectColumn: "project_id",
  },
  // The external More screens (Section 4.5.7 role table, A92), each for the role types whose menu lists it. Parents
  // come before their lines, which take the parent's project.
  {
    table: "timesheets",
    schema: "api_external",
    relation: "timesheets",
    select:
      "id,engagement_id,project_id,project_name,period_start,period_end,timesheet_state,worked_minutes,submitted_at,decided_at",
    projectColumn: "project_id",
    audiences: ["crew", "staff"],
  },
  {
    table: "per_diems",
    schema: "api_external",
    relation: "per_diems",
    select: "id,engagement_id,project_id,project_name,day,amount_minor,currency_code",
    projectColumn: "project_id",
    audiences: ["crew", "staff"],
  },
  {
    table: "travel_segments",
    schema: "api_external",
    relation: "travel",
    select:
      "id,engagement_id,project_id,project_name,travel_mode,operator_name,service_identifier,confirmation_identifier,departs_from,departs_at,departs_time_zone,arrives_at_place,arrives_at,arrives_time_zone",
    projectColumn: "project_id",
    audiences: ["crew", "staff"],
  },
  {
    table: "lodging",
    schema: "api_external",
    relation: "lodging",
    select: "id,project_id,project_name,block_title,hotel_name,person_id,check_in_on,check_out_on",
    projectColumn: "project_id",
    personColumn: "person_id",
    audiences: ["crew", "staff"],
  },
  {
    table: "onboarding_items",
    schema: "api_external",
    relation: "onboarding_items",
    select:
      "id,engagement_id,name,item_kind,is_blocking,verification_method,submitted_at,latest_outcome,expires_on,passes,satisfied",
    audiences: ["crew", "staff"],
  },
  {
    table: "purchase_orders",
    schema: "api_external",
    relation: "purchase_orders",
    select:
      "id,org_id,org_name,project_id,project_name,po_number,currency_code,po_state,total_minor,sent_at,acknowledged_at",
    projectColumn: "project_id",
    audiences: ["vendor"],
  },
  {
    table: "po_lines",
    schema: "api_external",
    relation: "po_lines",
    select:
      "id,purchase_order_id,line_number,description,quantity,unit_basis,unit_price_minor,amount_minor",
    audiences: ["vendor"],
    parent: { table: "purchase_orders", column: "purchase_order_id" },
  },
  {
    table: "deliveries",
    schema: "api_external",
    relation: "deliveries",
    select: "id,project_id,project_name,direction,tracking_identifier,ships_at,arrives_at",
    projectColumn: "project_id",
    audiences: ["vendor"],
  },
  {
    // Records the org shares with the vendor for review: where submittal requests arrive (Gateway's tab).
    table: "shared_records",
    schema: "api_external",
    relation: "records",
    select:
      "id,project_id,record_kind,record_subtype,record_state,title,starts_at,ends_at,due_at,time_zone",
    projectColumn: "project_id",
    audiences: ["vendor"],
  },
  {
    table: "deliverables",
    schema: "api_external",
    relation: "deliverables",
    select:
      "id,engagement_id,record_id,record_kind,title,due_at,deliverable_state,submitted_at,decided_at,return_reason,fee_minor,currency_code",
    audiences: ["contractor"],
  },
  {
    table: "advance_packets",
    schema: "api_external",
    relation: "advance_packets",
    select: "id,project_id,project_name,org_name,title,due_at,sent_at",
    projectColumn: "project_id",
    audiences: ["artist", "artist-representative"],
  },
  {
    table: "advance_sections",
    schema: "api_external",
    relation: "advance_sections",
    select: "id,advance_packet_id,position,title,prompt",
    audiences: ["artist", "artist-representative"],
    parent: { table: "advance_packets", column: "advance_packet_id" },
  },
  {
    table: "advance_submissions",
    schema: "api_external",
    relation: "advance_submissions",
    select:
      "id,advance_section_id,advance_recipient_id,submitted_at,reviewed_at,review_outcome,return_reason",
    audiences: ["artist", "artist-representative"],
    parent: { table: "advance_sections", column: "advance_section_id" },
  },
  {
    table: "riders",
    schema: "api_external",
    relation: "riders",
    select: "id,project_id,project_name,title",
    projectColumn: "project_id",
    audiences: ["artist", "artist-representative"],
  },
  {
    table: "rider_lines",
    schema: "api_external",
    relation: "rider_lines",
    select: "id,rider_id,description,quantity,fulfilled_at",
    audiences: ["artist", "artist-representative"],
    parent: { table: "riders", column: "rider_id" },
  },
  {
    table: "settlements",
    schema: "api_external",
    relation: "settlements",
    select:
      "id,engagement_id,project_id,project_name,settlement_number,title,currency_code,settled_on,settlement_state,net_minor,submitted_at,responded_at",
    projectColumn: "project_id",
    audiences: ["artist", "artist-representative"],
  },
  {
    table: "settlement_lines",
    schema: "api_external",
    relation: "settlement_lines",
    select: "id,settlement_id,line_number,line_kind,description,amount_minor",
    audiences: ["artist", "artist-representative"],
    parent: { table: "settlements", column: "settlement_id" },
  },
  {
    table: "shared_reports",
    schema: "api_external",
    relation: "shared_reports",
    select:
      "id,engagement_id,project_id,project_name,title,shared_at,expires_at,export_format,finished_at,row_count",
    projectColumn: "project_id",
    audiences: ["client"],
  },
  {
    table: "sponsor_entitlements",
    schema: "api_external",
    relation: "sponsor_entitlements",
    select: "id,project_id,project_name,description,quantity,due_on,fulfilled_at,is_overdue",
    projectColumn: "project_id",
    audiences: ["sponsor"],
  },
  {
    table: "engagement_documents",
    schema: "api_external",
    relation: "engagement_documents",
    select: "id,engagement_id,document_kind,title,expires_on,engagement_document_state",
    audiences: ["sponsor"],
  },
  {
    // Proof photos on the sponsor's engagements while capture is open (A140, 2332).
    table: "proof_of_performance_photos",
    schema: "api_external",
    relation: "proof_of_performance_photos",
    select: "id,engagement_id,sponsor_entitlement_id,project_id,media_uri,captured_at,created_at",
    projectColumn: "project_id",
    audiences: ["sponsor"],
  },
];

/** Canon reference rows every device caches for offline use (Section 13: reference available offline). */
const CANON_SOURCES: readonly Source[] = [
  {
    // The canon codes (decision D15): the swatch of every org's codes, and the list for an org that holds none.
    table: "canon_emergency_codes",
    schema: "xpms",
    relation: "emergency_code",
    select: "code,label,emergency,swatch,sort_order",
    map: (r) => ({ ...r, id: r["code"], sort_order: Number(r["sort_order"]) }),
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
  {
    table: "roles",
    schema: "xpms",
    relation: "role",
    select: "role_code,job_title",
    map: (r) => ({ id: r["role_code"], job_title: r["job_title"] }),
  },
];

/** Canon enumeration domain each canon table filters on. */
export const CANON_DOMAIN: Readonly<Record<string, string>> = {
  incident_severities: "Incident Severity",
  inspection_result_values: "Inspection Result",
};

/**
 * The person's own certifications and documents for the Compass Profile (Section 4.3 item 13, A109). The views return
 * only the signed-in person's rows (2080), so every audience reads them there, members included.
 */
const PERSON_SOURCES: readonly Source[] = [
  {
    table: "profile_certifications",
    schema: "api_external",
    relation: "my_profile_certifications",
    select:
      "id,person_id,source,name,issuing_body,issued_on,expires_on,is_verified,verified_by_org_name,time_zone",
    personColumn: "person_id",
  },
  {
    table: "profile_documents",
    schema: "api_external",
    relation: "my_profile_documents",
    select:
      "id,person_id,document_type,document_kind,title,org_name,project_name,issuer,expires_on,document_state,time_zone,file_version_id,file_version_number,file_object_name,file_name,file_content_type,file_size_bytes,file_classification",
    personColumn: "person_id",
  },
];

export function sourcesFor(audience: Audience): readonly Source[] {
  return [
    ...(isInternal(audience) ? INTERNAL_SOURCES : EXTERNAL_SOURCES),
    ...PERSON_SOURCES,
    ...CANON_SOURCES,
  ].filter((s) => !s.audiences || s.audiences.includes(audience));
}

/**
 * The sources for a person in several orgs (Section 4.5.7): the app tables when they are a member of any
 * org, the api_external views when any org engages them, and their own profile rows and canon once. A table can then come from both;
 * the downloader merges its rows before writing, and each row still passes its own org's scope.
 */
export function sourcesForAudiences(audiences: readonly Audience[]): readonly Source[] {
  const internal = audiences.some((a) => isInternal(a));
  const external = audiences.some((a) => !isInternal(a));
  return [
    ...(internal ? INTERNAL_SOURCES : []),
    ...(external ? EXTERNAL_SOURCES : []),
    ...PERSON_SOURCES,
    ...CANON_SOURCES,
  ];
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
