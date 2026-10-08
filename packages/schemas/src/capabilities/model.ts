/**
 * Closed lists and shapes of the capability registry (Section 8, ADR 0005).
 *
 * The Postgres enums `app.capability_class`, `app.capability_reach` and `app.nav_group`
 * carry exactly these values; a unit test compares them with the migration text.
 */

/** Platform roles per org, in band order (Section 8). */
export const ROLE_CODES = [
  "owner",
  "admin",
  "manager",
  "member",
  "collaborator",
  "field",
  "viewer",
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

/** What kind of act a capability authorizes. Grant derivation reads it. */
export const CAPABILITY_CLASSES = ["read", "write", "approve", "manage", "export"] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/** How far a role grant reaches, narrowest first so enum order compares by breadth. */
export const CAPABILITY_REACHES = ["own", "assigned", "organization"] as const;
export type CapabilityReach = (typeof CAPABILITY_REACHES)[number];

/** Section 4.5.9 visibility levels. */
export const VISIBILITY_LEVELS = ["full", "read", "assigned", "own", "hidden"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** Atlas sidebar groups (Section 4.5.2) plus the settings trees (Section 4.5.6). */
export const NAV_GROUPS = [
  "workspace",
  "production",
  "operations",
  "people",
  "commercial",
  "knowledge",
  "footer",
  "settings",
  "personal",
] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

/**
 * Every Atlas module of Section 4.2 plus the Section 4.5.9 rows that are not modules
 * (Inbox, My Work, Audit log, Org settings, Data and Privacy, Personal settings).
 */
export const REQUIRED_MODULES = [
  "home",
  "inbox",
  "my_work",
  "projects",
  "activity",
  "schedule",
  "work",
  "show",
  "knowledge",
  "places",
  "logistics",
  "advancing",
  "hospitality",
  "assets",
  "opportunities",
  "people",
  "crew",
  "credentials",
  "finance",
  "procurement",
  "vendors",
  "safety",
  "canon",
  "reports",
  "audit",
  "org",
  "data",
  "me",
] as const;

/** The 42 organization settings sections of Section 4.5.6, in order. */
export const ORG_SETTINGS_SECTIONS = [
  "organization_profile",
  "general",
  "legal_entities_and_fiscal",
  "members",
  "roles_and_capabilities",
  "teams",
  "workspaces",
  "departments_and_disciplines",
  "locations_and_venues",
  "security",
  "access_reviews",
  "white_label",
  "modules",
  "canon_extensions",
  "templates",
  "custom_fields",
  "custom_objects",
  "views_and_defaults",
  "numbering",
  "automations",
  "approval_policies",
  "spend_authority",
  "separation_of_duties",
  "time_and_attendance",
  "scheduling",
  "payroll_and_time_off",
  "gateway_and_marketplace",
  "communication",
  "notifications_defaults",
  "ai_features",
  "help_and_support",
  "integrations",
  "api_keys_and_service_accounts",
  "webhooks",
  "localization",
  "billing_and_plan",
  "partner",
  "usage",
  "data_and_privacy",
  "audit_log",
  "legal",
  "danger_zone",
] as const;

/** The 15 personal settings sections of Section 4.5.6, in order. */
export const PERSONAL_SETTINGS_SECTIONS = [
  "profile",
  "profile_privacy",
  "account",
  "security",
  "organizations",
  "preferences",
  "accessibility",
  "notifications",
  "out_of_office",
  "work_details",
  "payout_and_tax",
  "calendar_feeds",
  "connected_apps",
  "keyboard_shortcuts",
  "developer",
] as const;

export interface RoleDefinition {
  readonly code: RoleCode;
  readonly band: number;
  readonly description: string;
}

export interface CapabilityDefinition {
  readonly code: string;
  readonly class: CapabilityClass;
  readonly description: string;
  readonly own: boolean;
  /** When present, replaces derivation: the roles listed get the reach given, others nothing. */
  readonly roles: Readonly<Partial<Record<RoleCode, CapabilityReach>>> | null;
}

export interface ModuleDefinition {
  readonly code: string;
  readonly group: NavGroup;
  readonly projectScoped: boolean;
  readonly visibility: Readonly<Record<RoleCode, VisibilityLevel>>;
  readonly capabilities: readonly CapabilityDefinition[];
}

export interface SettingsSection {
  readonly section: string;
  readonly capability: string;
}

export interface CapabilityRegistry {
  readonly version: number;
  readonly roles: readonly RoleDefinition[];
  readonly modules: readonly ModuleDefinition[];
  readonly settingsSections: readonly SettingsSection[];
  readonly personalSettingsSections: readonly SettingsSection[];
}

/** One default grant of a capability to a platform role. */
export interface RoleGrant {
  readonly role: RoleCode;
  readonly capability: string;
  readonly reach: CapabilityReach;
}

export function reachRank(reach: CapabilityReach): number {
  return CAPABILITY_REACHES.indexOf(reach);
}
