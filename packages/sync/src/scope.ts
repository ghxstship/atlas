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
}

export type ScopeKey = Exclude<keyof DownloadScope, "audience">;

export interface ScopeAlternative {
  readonly column: string;
  readonly key: ScopeKey;
  /** Audiences this alternative serves; omitted means every audience. */
  readonly audiences?: readonly Audience[];
}

export interface TableRule {
  readonly table: string;
  readonly anyOf: readonly ScopeAlternative[];
  /** Canon reference tables shared by every tenant, such as emergency codes. */
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
  {
    table: "geofence_shapes",
    anyOf: [
      { column: "project_id", key: "readableProjectIds", audiences: INTERNAL },
      { column: "project_id", key: "engagedProjectIds", audiences: OPERATIONAL_EXTERNAL },
    ],
  },
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
  {
    table: "run_of_show",
    anyOf: [
      internalProject,
      {
        column: "project_id",
        key: "engagedProjectIds",
        audiences: ["crew", "staff", "artist", "artist-representative", "client"],
      },
    ],
  },
  {
    table: "cues",
    anyOf: [
      internalProject,
      {
        column: "project_id",
        key: "engagedProjectIds",
        audiences: ["crew", "staff", "artist", "artist-representative", "client"],
      },
    ],
  },
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
  { table: "sops", anyOf: [internalOrg] },
  { table: "kiosk_roster", anyOf: [internalProject] },
  { table: "emergency_codes", anyOf: [], global: true },
  { table: "incident_severities", anyOf: [], global: true },
  { table: "inspection_result_values", anyOf: [], global: true },
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
    return typeof value === "string" && scope[alt.key].includes(value);
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
