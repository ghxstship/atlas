/**
 * Download scope (Section 8.7: sync rules apply the same engagement scope, so an external device never
 * stores another party's data; Section 13: sync rules are tested against the same scope rules as RLS).
 *
 * The PowerSync service filters on the server (sync-rules.yaml). This module is the device-side check that
 * runs on every downloaded row before it is written: a row that matches no rule for the signed-in person's
 * scope is refused and reported, never stored. Unknown tables are refused by default.
 */

import type { Row } from "./store";

export const INTERNAL_AUDIENCES = ["field", "field-supervisor"] as const;
export const EXTERNAL_AUDIENCES = [
  "client",
  "vendor",
  "contractor",
  "crew",
  "staff",
  "artist",
  "artist-representative",
  "sponsor",
] as const;

export type InternalAudience = (typeof INTERNAL_AUDIENCES)[number];
export type ExternalAudience = (typeof EXTERNAL_AUDIENCES)[number];
export type Audience = InternalAudience | ExternalAudience;

export function isInternal(audience: Audience): audience is InternalAudience {
  return (INTERNAL_AUDIENCES as readonly string[]).includes(audience);
}

/** What the signed-in person may hold on this device, resolved by the server at sign-in and on refresh. */
export interface DownloadScope {
  readonly audience: Audience;
  readonly personIds: readonly string[];
  readonly orgIds: readonly string[];
  /** Internal: memberships of the person. Empty for external users (externals never hold memberships). */
  readonly membershipIds: readonly string[];
  /** Internal: projects whose operational records the person may read. */
  readonly readableProjectIds: readonly string[];
  /** External: engagements whose operational area is open now (Active or Closing). */
  readonly engagementIds: readonly string[];
  /** External: projects reached through those engagements. */
  readonly engagedProjectIds: readonly string[];
  /**
   * External: engagements whose onboarding area is open (Onboarding and Blocked as well as Active and Closing), for
   * the onboarding checklist a person works through before operational access opens (A92). Absent holds none.
   */
  readonly onboardingEngagementIds?: readonly string[];
}

export type ScopeKey = Exclude<keyof DownloadScope, "audience">;

export interface ScopeAlternative {
  readonly column: string;
  readonly key: ScopeKey;
  /** Audiences this alternative serves; omitted means every audience. */
  readonly audiences?: readonly Audience[];
  /**
   * Served only by the REST downloader, through an api_external view or a join whose filter a PowerSync
   * sync rule cannot express; sync-rules.yaml carries no bucket for it.
   */
  readonly restOnly?: boolean;
}

export interface TableRule {
  readonly table: string;
  readonly anyOf: readonly ScopeAlternative[];
  /** Canon reference tables shared by every tenant, such as the canon emergency codes. */
  readonly global?: boolean;
}

const INTERNAL: readonly Audience[] = INTERNAL_AUDIENCES;
const OPERATIONAL_EXTERNAL: readonly Audience[] = EXTERNAL_AUDIENCES;

const ownOrEngaged: readonly ScopeAlternative[] = [
  { column: "membership_id", key: "membershipIds", audiences: INTERNAL },
  { column: "engagement_id", key: "engagementIds", audiences: OPERATIONAL_EXTERNAL },
];

const internalProject: ScopeAlternative = {
  column: "project_id",
  key: "readableProjectIds",
  audiences: INTERNAL,
};
const internalOrg: ScopeAlternative = { column: "org_id", key: "orgIds", audiences: INTERNAL };
const clientRunningOrder: ScopeAlternative = {
  column: "project_id",
  key: "engagedProjectIds",
  audiences: ["client"],
};
const CREW_STAFF: readonly Audience[] = ["crew", "staff"];
const VENDOR: readonly Audience[] = ["vendor"];
const CONTRACTOR: readonly Audience[] = ["contractor"];
const ARTIST_PARTY: readonly Audience[] = ["artist", "artist-representative"];
const CLIENT: readonly Audience[] = ["client"];
const SPONSOR: readonly Audience[] = ["sponsor"];
const artistSetTimes: ScopeAlternative = {
  column: "project_id",
  key: "engagedProjectIds",
  audiences: ["artist", "artist-representative"],
  restOnly: true,
};

/** The device-side mirror of sync-rules.yaml. Order follows the Compass feature list (Section 4.3). */
export const TABLE_RULES: readonly TableRule[] = [
  {
    table: "projects",
    anyOf: [
      { column: "id", key: "readableProjectIds", audiences: INTERNAL },
      { column: "id", key: "engagedProjectIds", audiences: OPERATIONAL_EXTERNAL },
    ],
  },
  { table: "shifts", anyOf: [...ownOrEngaged, internalProject] },
  {
    table: "shift_swaps",
    anyOf: [
      { column: "requested_by_membership_id", key: "membershipIds", audiences: INTERNAL },
      { column: "proposed_membership_id", key: "membershipIds", audiences: INTERNAL },
      internalProject,
    ],
  },
  { table: "time_entries", anyOf: [...ownOrEngaged, internalProject] },
  { table: "clock_punches", anyOf: [...ownOrEngaged, internalProject] },
  // Geofences belong to venues, not projects; internal devices hold their org's shapes. External devices
  // have no venue scope, and the server checks every punch against the geofence anyway (record_punch).
  { table: "geofence_shapes", anyOf: [internalOrg] },
  {
    table: "day_sheets",
    anyOf: [
      internalProject,
      {
        column: "project_id",
        key: "engagedProjectIds",
        audiences: ["crew", "staff", "artist", "artist-representative", "client"],
      },
    ],
  },
  // api_external.run_of_show and api_external.cues give a Client the whole running order and an artist only
  // their own set times. A sync rule cannot join cues to engagement_cues, so Client devices sync them and
  // artists receive their set times through the REST downloader, which reads the views.
  { table: "run_of_show", anyOf: [internalProject, clientRunningOrder, artistSetTimes] },
  { table: "cues", anyOf: [internalProject, clientRunningOrder, artistSetTimes] },
  { table: "incidents", anyOf: [internalProject, { column: "reported_by", key: "personIds" }] },
  { table: "incident_media", anyOf: [internalProject, { column: "created_by", key: "personIds" }] },
  { table: "inspection_templates", anyOf: [internalOrg] },
  { table: "inspection_items", anyOf: [internalOrg] },
  { table: "inspections", anyOf: [internalProject] },
  { table: "inspection_results", anyOf: [internalProject] },
  {
    table: "credentials",
    anyOf: [
      { column: "holder_person_id", key: "personIds" },
      {
        column: "engagement_id",
        key: "engagementIds",
        audiences: ["artist", "artist-representative"],
      },
      internalProject,
    ],
  },
  { table: "access_grid", anyOf: [internalProject] },
  { table: "access_scans", anyOf: [internalProject] },
  { table: "asset_units", anyOf: [internalOrg] },
  { table: "asset_identifiers", anyOf: [internalOrg] },
  {
    table: "asset_custody",
    anyOf: [
      { column: "custodian_membership_id", key: "membershipIds", audiences: INTERNAL },
      { column: "custodian_engagement_id", key: "engagementIds", audiences: ["crew", "staff"] },
      internalOrg,
    ],
  },
  { table: "scan_intake", anyOf: [internalProject] },
  {
    table: "dock_slots",
    anyOf: [
      internalProject,
      { column: "engagement_id", key: "engagementIds", audiences: ["vendor"] },
    ],
  },
  {
    table: "radio_channels",
    anyOf: [
      internalProject,
      { column: "project_id", key: "engagedProjectIds", audiences: OPERATIONAL_EXTERNAL },
    ],
  },
  // Compass logistics (Section 4.3 item 8): the gate queue, the marshalling yard log and fulfillments.
  { table: "gate_queue", anyOf: [internalProject] },
  { table: "marshalling_log", anyOf: [internalProject] },
  { table: "fulfillments", anyOf: [internalProject] },
  { table: "sops", anyOf: [internalOrg] },
  { table: "zones", anyOf: [internalOrg] },
  // The org's own emergency codes (WP18, 1612): members read them; others fall back to the canon codes.
  { table: "emergency_codes", anyOf: [internalOrg] },
  // Memberships joined to people's names: no single replicable table holds it.
  { table: "kiosk_roster", anyOf: [{ ...internalOrg, restOnly: true }] },
  // Expenses (Section 4.3 item 11, A92): the budget lines the person may post to with their budget's project and
  // currency (app.expense_budget_lines, 1622), and the person's own expenses. Neither has a sync rule yet, so the
  // REST downloader serves both.
  { table: "budget_lines", anyOf: [{ ...internalProject, restOnly: true }] },
  {
    table: "expenses",
    anyOf: [
      { column: "submitter_person_id", key: "personIds", audiences: INTERNAL, restOnly: true },
    ],
  },
  // The person's own certifications and documents on the Compass Profile (Section 4.3 item 13, A109): api_external views
  // that return only the signed-in person's rows (2080), for every audience. PowerSync does not replicate views, so the
  // REST downloader serves them.
  {
    table: "profile_certifications",
    anyOf: [{ column: "person_id", key: "personIds", restOnly: true }],
  },
  {
    table: "profile_documents",
    anyOf: [{ column: "person_id", key: "personIds", restOnly: true }],
  },
  // The external More screens (Section 4.5.7 role table, A92) read api_external projections, which PowerSync does
  // not replicate, so the REST downloader serves them. Each table admits only the role types whose menu lists it;
  // lines without a project of their own take their parent's on download.
  ...(
    [
      ["timesheets", "engagement_id", "engagementIds", CREW_STAFF],
      ["per_diems", "engagement_id", "engagementIds", CREW_STAFF],
      ["travel_segments", "engagement_id", "engagementIds", CREW_STAFF],
      ["lodging", "person_id", "personIds", CREW_STAFF],
      ["onboarding_items", "engagement_id", "onboardingEngagementIds", CREW_STAFF],
      ["purchase_orders", "project_id", "engagedProjectIds", VENDOR],
      ["po_lines", "project_id", "engagedProjectIds", VENDOR],
      ["deliveries", "project_id", "engagedProjectIds", VENDOR],
      ["shared_records", "project_id", "engagedProjectIds", VENDOR],
      ["deliverables", "engagement_id", "engagementIds", CONTRACTOR],
      ["advance_packets", "project_id", "engagedProjectIds", ARTIST_PARTY],
      ["advance_sections", "project_id", "engagedProjectIds", ARTIST_PARTY],
      ["advance_submissions", "project_id", "engagedProjectIds", ARTIST_PARTY],
      ["riders", "project_id", "engagedProjectIds", ARTIST_PARTY],
      ["rider_lines", "project_id", "engagedProjectIds", ARTIST_PARTY],
      ["settlements", "engagement_id", "engagementIds", ARTIST_PARTY],
      ["settlement_lines", "project_id", "engagedProjectIds", ARTIST_PARTY],
      ["shared_reports", "engagement_id", "engagementIds", CLIENT],
      ["sponsor_entitlements", "project_id", "engagedProjectIds", SPONSOR],
      ["engagement_documents", "engagement_id", "engagementIds", SPONSOR],
      ["proof_of_performance_photos", "engagement_id", "engagementIds", SPONSOR],
    ] as const
  ).map(([table, column, key, audiences]): TableRule => ({
    table,
    anyOf: [{ column, key, audiences, restOnly: true }],
  })),
  // The canon codes: the swatch of every org's codes, and the list an org that holds no codes shows.
  { table: "canon_emergency_codes", anyOf: [], global: true },
  { table: "incident_severities", anyOf: [], global: true },
  { table: "inspection_result_values", anyOf: [], global: true },
  // Canon job titles, so a shift reads "Head Arena / Festival Rigger" instead of its role code.
  { table: "roles", anyOf: [], global: true },
];

const RULES = new Map(TABLE_RULES.map((rule) => [rule.table, rule]));

export function ruleFor(table: string): TableRule | undefined {
  return RULES.get(table);
}

/** True when the person's scope admits the row. Deny by default. */
export function admits(table: string, row: Row, scope: DownloadScope): boolean {
  const rule = RULES.get(table);
  if (!rule) return false;
  if (rule.global) return true;
  return rule.anyOf.some((alt) => {
    if (alt.audiences && !alt.audiences.includes(scope.audience)) return false;
    const value = row[alt.column];
    return typeof value === "string" && (scope[alt.key] ?? []).includes(value);
  });
}

export interface FilterResult {
  readonly kept: Row[];
  readonly refused: Row[];
}

export function filterDownload(
  table: string,
  rows: readonly Row[],
  scope: DownloadScope,
): FilterResult {
  const kept: Row[] = [];
  const refused: Row[] = [];
  for (const row of rows) (admits(table, row, scope) ? kept : refused).push(row);
  return { kept, refused };
}
