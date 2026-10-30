/**
 * Who may use which Compass feature (Section 4.3, Section 4.5.7 role table, Section 8.7).
 *
 * Internal users reach a feature through their capabilities on the current project. External users reach
 * it through an engagement whose operational area is open (Active or Closing) and their role type; they
 * never hold memberships. Every "no" carries a reason, so the screen can show a refusal state that names
 * the next action instead of an empty page.
 */
import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import type { Audience } from "@xos/sync";
import { isInternal } from "@xos/sync";
import { navigation } from "../navigation.generated";

export type EngagementState =
  "Onboarding" | "Blocked" | "Active" | "Closing" | "Complete" | "Canceled";

export interface EngagementSummary {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly roleType: Audience;
  readonly state: EngagementState;
}

export interface CompassIdentity {
  readonly personId: string;
  readonly displayName: string;
  readonly audience: Audience;
  /** Internal: capability codes held on the current project. */
  readonly capabilities: readonly string[];
  /** Internal: the person's membership in the current org. */
  readonly membershipId: string | null;
  /** External: engagements across every org (Section 4.5.7 org switching). */
  readonly engagements: readonly EngagementSummary[];
}

export type Feature =
  | "clock"
  | "kiosk.operate"
  | "shifts.swap"
  | "incidents.report"
  | "incidents.dispatch"
  | "inspections.perform"
  | "inspections.signOff"
  | "show.live"
  | "show.callCue"
  | "show.read"
  | "scan.asset"
  | "scan.receiving"
  | "scan.receiving.order"
  | "scan.credential.validate"
  | "scan.credential.badge"
  | "scan.lookup"
  | "crew.board"
  | "timesheets.approve"
  | "logistics.dock"
  | "logistics.yard"
  | "logistics.release"
  | "hospitality.fulfillment"
  | "expenses.submit";

export type Denial =
  /** The role type never has this feature (Section 4.5.7). */
  | "role"
  /** Internal: a capability is missing on this project. */
  | "capability"
  /** External: no engagement on this project has its operational area open. */
  | "engagement-not-active"
  /** External: the engagement reached Complete; Compass access ended (Section 8.7). */
  | "engagement-closed";

export type Access =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: Denial };

const ALLOW: Access = { allowed: true };
const deny = (reason: Denial): Access => ({ allowed: false, reason });

/** Capability each internal feature needs on the project (canon capability codes, Section 8). */
const INTERNAL_CAPABILITY: Readonly<Record<Feature, CapabilityCode | null>> = {
  clock: "crew.time_entry.write",
  "kiosk.operate": "org.time_attendance.write",
  "shifts.swap": "crew.swap.request",
  "incidents.report": "safety.incident.write",
  "incidents.dispatch": "safety.incident.dispatch",
  "inspections.perform": "safety.inspection.write",
  "inspections.signOff": "safety.inspection.sign_off",
  "show.live": "show.run_of_show.read",
  "show.callCue": "show.cue.call",
  "show.read": "show.run_of_show.read",
  "scan.asset": "assets.custody.write",
  "scan.receiving": "procurement.receipt.write",
  // Receiving against an order (R7a): app.receive_goods needs procurement.receipt.write on the project.
  "scan.receiving.order": "procurement.receipt.write",
  "scan.credential.validate": "credentials.scan.write",
  "scan.credential.badge": null,
  "scan.lookup": "assets.asset.read",
  "crew.board": "crew.shift.read",
  "timesheets.approve": "crew.timesheet.approve",
  "logistics.dock": "logistics.dock_slot.write",
  "logistics.yard": "logistics.yard.write",
  "logistics.release": "logistics.release.approve",
  "hospitality.fulfillment": "hospitality.fulfillment.write",
  "expenses.submit": "finance.expense.write",
};

/** External role types per feature (Section 4.5.7 role table and the sitemap's scan modes). */
const EXTERNAL_ROLES: Readonly<Record<Feature, readonly Audience[]>> = {
  clock: ["crew", "staff", "contractor"],
  "kiosk.operate": [],
  "shifts.swap": [],
  "incidents.report": [],
  "incidents.dispatch": [],
  "inspections.perform": [],
  "inspections.signOff": [],
  "show.live": [],
  "show.callCue": [],
  "show.read": ["client", "crew", "staff", "artist", "artist-representative"],
  "scan.asset": ["crew", "staff"],
  "scan.receiving": ["vendor"],
  // Externals never receive against an order: the order, its lines and the receipt are internal records.
  "scan.receiving.order": [],
  "scan.credential.validate": [],
  "scan.credential.badge": [
    "vendor",
    "contractor",
    "crew",
    "staff",
    "artist",
    "artist-representative",
  ],
  "scan.lookup": [],
  "crew.board": [],
  "timesheets.approve": [],
  "logistics.dock": [],
  "logistics.yard": [],
  "logistics.release": [],
  "hospitality.fulfillment": [],
  "expenses.submit": [],
};

/** Internal-only features that also need the supervisor audience (Section 4.5.7 supervisor mode). */
const SUPERVISOR_ONLY = new Set<Feature>([
  "crew.board",
  "timesheets.approve",
  "incidents.dispatch",
]);

/** Engagements whose operational area is open (Section 8.7 time box). */
export function operationalEngagements(
  identity: CompassIdentity,
  projectId: string | null,
): EngagementSummary[] {
  return identity.engagements.filter(
    (e) =>
      (e.state === "Active" || e.state === "Closing") &&
      (projectId === null || e.projectId === projectId),
  );
}

export function access(
  identity: CompassIdentity,
  feature: Feature,
  projectId: string | null,
): Access {
  if (isInternal(identity.audience)) {
    if (SUPERVISOR_ONLY.has(feature) && identity.audience !== "field-supervisor")
      return deny("role");
    const capability = INTERNAL_CAPABILITY[feature];
    if (capability === null) return ALLOW;
    return identity.capabilities.includes(capability) ? ALLOW : deny("capability");
  }
  if (!EXTERNAL_ROLES[feature].includes(identity.audience)) return deny("role");
  const onProject = identity.engagements.filter(
    (e) => projectId === null || e.projectId === projectId,
  );
  if (operationalEngagements(identity, projectId).some((e) => e.roleType === identity.audience)) {
    return ALLOW;
  }
  if (onProject.some((e) => e.state === "Complete" || e.state === "Canceled")) {
    return deny("engagement-closed");
  }
  return deny("engagement-not-active");
}

export type ScanMode = "asset" | "receiving" | "credential" | "lookup";
export type ScanScope = "all" | "own" | "assigned" | "own-and-party" | "acknowledgment";

export interface ScanModeGrant {
  readonly mode: ScanMode;
  readonly scope: ScanScope;
}

type AudienceNav = (typeof navigation.audiences)[Audience];

function nav(audience: Audience): AudienceNav {
  return navigation.audiences[audience];
}

/** Scan modes and their scope for the audience, in sitemap order. */
export function scanModes(audience: Audience): ScanModeGrant[] {
  return nav(audience).scanModes.map((m) => ({ mode: m.mode, scope: m.scope }));
}

export interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly readOnly: boolean;
  /** Sitemap conditions the device must meet to show the entry (Settings, Developer); empty for most. */
  readonly conditions: readonly string[];
  readonly children: readonly MenuEntry[];
}

function toMenu(entry: {
  id: string;
  label: string;
  route: string;
  access: string;
  conditions?: readonly string[];
  children: readonly unknown[];
}): MenuEntry {
  return {
    id: entry.id,
    label: entry.label,
    route: entry.route,
    readOnly: entry.access === "read",
    conditions: entry.conditions ?? [],
    children: (entry.children as (typeof entry)[]).map(toMenu),
  };
}

/** The tab bar for the audience: five tabs for everyone, plus Crew for supervisors. */
export function tabBar(audience: Audience): MenuEntry[] {
  return nav(audience).tabs.map(toMenu);
}

/** The More menu for the audience, in the sitemap's order (external additions first). */
export function moreMenu(audience: Audience): MenuEntry[] {
  return (
    tabBar(audience)
      .find((t) => t.id === "more")
      ?.children.slice() ?? []
  );
}

/** More entries Compass renders itself; the others live in Gateway (external) or Atlas (internal). */
export const NATIVE_MORE: ReadonlySet<string> = new Set([
  "incidents",
  "inspections",
  "logistics",
  "show",
  "run-of-show",
  "reference",
  "offline-queue",
  "profile",
  "settings",
  // A92 (A65-011 parts 1 and 2): expenses, and every external role type's entries (src/domain/external.ts).
  "expenses",
  "timesheets",
  "per-diem",
  "travel-and-lodging",
  "onboarding",
  "purchase-orders",
  "deliveries",
  "submittals",
  "time-entries",
  "deliverables",
  "advance-summary",
  "rider",
  "settlement",
  "reports",
  "proof-of-performance",
  // R5: project facts on the person's own roster entries, online only.
  "project-details",
]);

export interface MoreSections {
  /** Entries Compass opens as its own screens, in the sitemap's order. */
  readonly native: readonly MenuEntry[];
  /** Entries whose screens are not in Compass yet, gathered behind one link out. */
  readonly elsewhere: readonly MenuEntry[];
}

/**
 * The More menu split for the phone (finding A59-026): Compass's own screens, then everything it
 * does not render yet gathered behind one row that opens the right app, instead of one "this is in
 * Gateway" page per entry.
 */
export function moreSections(audience: Audience): MoreSections {
  const items = moreMenu(audience);
  return {
    native: items.filter((m) => NATIVE_MORE.has(m.id)),
    elsewhere: items.filter((m) => !NATIVE_MORE.has(m.id)),
  };
}

/**
 * Where the gathered entries open: an external person's engagements in Gateway, whose tabs hold
 * timesheets, per diem, travel, onboarding, purchase orders and the rest (Section 4.5.8); an
 * internal member's Atlas, which opens on their organization.
 */
export function elsewhereLink(
  audience: Audience,
  urls: { readonly atlasUrl: string; readonly gatewayUrl: string },
): { readonly app: "atlas" | "gateway"; readonly url: string } {
  const trim = (u: string) => u.replace(/\/+$/, "");
  return isInternal(audience)
    ? { app: "atlas", url: `${trim(urls.atlasUrl)}/` }
    : { app: "gateway", url: `${trim(urls.gatewayUrl)}/work/engagements` };
}

/**
 * Where a person keeps their certifications (finding A59-026): an external person on their Gateway
 * profile; an internal member in Atlas, which opens on their organization, never Gateway.
 */
export function certificationsUrl(
  audience: Audience,
  urls: { readonly atlasUrl: string; readonly gatewayUrl: string },
): string {
  return isInternal(audience)
    ? elsewhereLink(audience, urls).url
    : `${urls.gatewayUrl.replace(/\/+$/, "")}/profile`;
}

/**
 * Where a person manages the documents on their Compass Profile (A109): an external person in Gateway's Documents,
 * where they sign and renew them; an internal member in Atlas, which opens on their organization.
 */
export function documentsUrl(
  audience: Audience,
  urls: { readonly atlasUrl: string; readonly gatewayUrl: string },
): string {
  return isInternal(audience)
    ? elsewhereLink(audience, urls).url
    : `${urls.gatewayUrl.replace(/\/+$/, "")}/documents`;
}

/** Today's content blocks for the audience, with their message keys. */
export function todayBlocks(audience: Audience): { id: string; label: string }[] {
  const labels: Readonly<Record<string, string>> = navigation.contentLabels;
  return nav(audience).today.map((id) => ({ id, label: labels[id] ?? id }));
}
