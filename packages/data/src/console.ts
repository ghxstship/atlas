import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { bool, num, numOrNull, rpc, str, strOrNull, type Raw } from "./platform-common.ts";

/**
 * The operator console (A90, migrations 1470 to 1474; Section 4.10, Section 6, Section 8). Every call runs as the
 * signed-in operator's own session, never the service role: each console RPC checks the operator, the role's
 * permission and the second factor in the database (private.require_platform_operator) and writes the console
 * ledger, and a change to a tenant row lands in that tenant's audit ledger with the operator as the actor.
 */

export type OperatorRole = "Support" | "Trust and Safety" | "Administrator";

export const CONSOLE_PERMISSIONS = [
  "tenants.read",
  "support.sessions",
  "flags.write",
  "flags.kill_switch",
  "plans.write",
  "moderation.decide",
  "banners.write",
  "operators.manage",
] as const;
export type ConsolePermission = (typeof CONSOLE_PERMISSIONS)[number];

export interface Operator {
  readonly personId: string;
  readonly fullName: string | null;
  readonly email: string | null;
  readonly role: OperatorRole;
  readonly permissions: readonly ConsolePermission[];
  /** Whether this session passed a second factor; every console action needs it. */
  readonly secondFactor: boolean;
}

const ROLES: readonly OperatorRole[] = ["Support", "Trust and Safety", "Administrator"];

const isPermission = (v: unknown): v is ConsolePermission =>
  typeof v === "string" && (CONSOLE_PERMISSIONS as readonly string[]).includes(v);

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};

/** The signed-in operator, or null for anyone off the platform team (the console then signs them out). */
export async function getOperator(db: XosClient): Promise<Result<Operator | null>> {
  return rpc(db, "console_whoami", {}, (data) => {
    const row = arr(data)[0] as Raw | undefined;
    const role = ROLES.find((r) => r === row?.["operator_role"]);
    if (!row || !role) return null;
    return {
      personId: str(row["person_id"]),
      fullName: strOrNull(row["full_name"]),
      email: strOrNull(row["email"]),
      role,
      permissions: arr(row["permissions"]).filter(isPermission),
      secondFactor: bool(row["second_factor"]),
    };
  });
}

/** Whether the operator's role holds a console permission. The database checks again on every call. */
export function can(operator: Operator | null, permission: ConsolePermission): boolean {
  return operator !== null && operator.permissions.includes(permission);
}

// Tenants --------------------------------------------------------------------------------------------------------------

export type SubscriptionState = "trialing" | "active" | "past_due" | "read_only" | "canceled";

export interface OrgSearchRow {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  /** The plan in force: a live Plan override's, the subscription's, or access. */
  readonly planCode: string;
  readonly subscriptionPlanCode: string | null;
  readonly subscriptionState: SubscriptionState | null;
  readonly ownerName: string | null;
  readonly ownerEmail: string | null;
  readonly seats: number;
  readonly canceled: boolean;
  readonly parentOrgName: string | null;
  readonly createdAt: string;
}

export async function searchOrgs(
  db: XosClient,
  input: {
    readonly query?: string;
    readonly planCode?: string | null;
    readonly limit?: number;
  } = {},
): Promise<Result<OrgSearchRow[]>> {
  return rpc(
    db,
    "console_search_orgs",
    {
      p_query: input.query?.trim() ? input.query.trim() : null,
      p_plan_code: input.planCode ?? null,
      p_limit: input.limit ?? 50,
    },
    (data) =>
      arr(data).map((d) => {
        const r = obj(d);
        return {
          orgId: str(r["org_id"]),
          name: str(r["name"]),
          slug: str(r["slug"]),
          planCode: str(r["plan_code"]),
          subscriptionPlanCode: strOrNull(r["subscription_plan_code"]),
          subscriptionState: strOrNull(r["subscription_state"]) as SubscriptionState | null,
          ownerName: strOrNull(r["owner_name"]),
          ownerEmail: strOrNull(r["owner_email"]),
          seats: num(r["seats"]),
          canceled: bool(r["canceled"]),
          parentOrgName: strOrNull(r["parent_org_name"]),
          createdAt: str(r["created_at"]),
        };
      }),
  );
}

export interface FlagState {
  readonly flagKey: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly killSwitch: boolean;
  readonly requiredPlanFeature: string | null;
  readonly enabled: boolean;
  readonly override: {
    readonly id: string;
    readonly enabled: boolean;
    readonly reason: string;
    readonly expiresAt: string | null;
    readonly setBy: string | null;
    readonly setAt: string;
    readonly live: boolean;
  } | null;
}

export type PlanOverrideKind = "Plan" | "Feature" | "Limit";

export interface PlanOverride {
  readonly id: string;
  readonly kind: PlanOverrideKind;
  readonly planCode: string | null;
  readonly featureCode: string | null;
  readonly featureEnabled: boolean | null;
  readonly limitCode: string | null;
  readonly limitValue: number | null;
  readonly reason: string;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly setBy: string | null;
  readonly live: boolean;
}

export interface OrgDetail {
  readonly org: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly createdAt: string;
    readonly parent: { readonly id: string; readonly name: string; readonly slug: string } | null;
    readonly clientCount: number;
  };
  readonly planCode: string;
  readonly subscription: {
    readonly planCode: string;
    readonly state: SubscriptionState;
    readonly extraSeats: number;
    readonly grandfathered: boolean;
    readonly since: string;
  } | null;
  readonly readOnly: boolean;
  readonly cancellation: {
    readonly canceledAt: string;
    readonly readOnlyUntil: string;
    readonly purgeAfter: string;
  } | null;
  readonly usage: {
    readonly seats: number;
    readonly fieldMembers: number;
    readonly activeProjects: number;
    readonly monthStart: string;
    readonly meters: readonly { readonly meterCode: string; readonly quantity: number }[];
  };
  readonly limits: readonly {
    readonly limitCode: string;
    readonly limitValue: number | null;
    readonly planValue: number | null;
  }[];
  readonly features: readonly {
    readonly featureCode: string;
    readonly enabled: boolean;
    readonly inPlan: boolean;
  }[];
  readonly flags: readonly FlagState[];
  readonly planOverrides: readonly PlanOverride[];
  readonly owners: readonly { readonly name: string | null; readonly email: string | null }[];
  readonly supportSessions: readonly {
    readonly id: string;
    readonly reason: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly endedAt: string | null;
    readonly granteeOrgName: string | null;
    readonly open: boolean;
  }[];
}

function parsePlanOverride(d: unknown): PlanOverride {
  const r = obj(d);
  return {
    id: str(r["id"]),
    kind: str(r["kind"]) as PlanOverrideKind,
    planCode: strOrNull(r["plan_code"]),
    featureCode: strOrNull(r["feature_code"]),
    featureEnabled: typeof r["feature_enabled"] === "boolean" ? r["feature_enabled"] : null,
    limitCode: strOrNull(r["limit_code"]),
    limitValue: numOrNull(r["limit_value"]),
    reason: str(r["reason"]),
    startsAt: str(r["starts_at"]),
    expiresAt: str(r["expires_at"]),
    endedAt: strOrNull(r["ended_at"]),
    endReason: strOrNull(r["end_reason"]),
    setBy: strOrNull(r["set_by"]),
    live: bool(r["live"]),
  };
}

function parseFlag(d: unknown): FlagState {
  const r = obj(d);
  const o = r["override"] === null || r["override"] === undefined ? null : obj(r["override"]);
  return {
    flagKey: str(r["flag_key"]),
    description: str(r["description"]),
    defaultEnabled: bool(r["default_enabled"]),
    killSwitch: bool(r["kill_switch"]),
    requiredPlanFeature: strOrNull(r["required_plan_feature"]),
    enabled: bool(r["enabled"]),
    override: o
      ? {
          id: str(o["id"]),
          enabled: bool(o["enabled"]),
          reason: str(o["reason"]),
          expiresAt: strOrNull(o["expires_at"]),
          setBy: strOrNull(o["set_by"]),
          setAt: str(o["set_at"]),
          live: bool(o["live"]),
        }
      : null,
  };
}

/** Parses app.console_org_detail's document. */
export function parseOrgDetail(data: unknown): OrgDetail {
  const d = obj(data);
  const org = obj(d["org"]);
  const parent = org["parent"] ? obj(org["parent"]) : null;
  const plan = obj(d["plan"]);
  const sub = plan["subscription"] ? obj(plan["subscription"]) : null;
  const status = obj(d["status"]);
  const cancellation = status["cancellation"] ? obj(status["cancellation"]) : null;
  const usage = obj(d["usage"]);
  return {
    org: {
      id: str(org["id"]),
      name: str(org["name"]),
      slug: str(org["slug"]),
      createdAt: str(org["created_at"]),
      parent: parent
        ? { id: str(parent["id"]), name: str(parent["name"]), slug: str(parent["slug"]) }
        : null,
      clientCount: num(org["client_count"]),
    },
    planCode: str(plan["plan_code"]),
    subscription: sub
      ? {
          planCode: str(sub["plan_code"]),
          state: str(sub["state"]) as SubscriptionState,
          extraSeats: num(sub["extra_seats"]),
          grandfathered: bool(sub["grandfathered"]),
          since: str(sub["since"]),
        }
      : null,
    readOnly: bool(status["read_only"]),
    cancellation: cancellation
      ? {
          canceledAt: str(cancellation["canceled_at"]),
          readOnlyUntil: str(cancellation["read_only_until"]),
          purgeAfter: str(cancellation["purge_after"]),
        }
      : null,
    usage: {
      seats: num(usage["seats"]),
      fieldMembers: num(usage["field_members"]),
      activeProjects: num(usage["active_projects"]),
      monthStart: str(usage["month_start"]),
      meters: arr(usage["meters"]).map((m) => ({
        meterCode: str(obj(m)["meter_code"]),
        quantity: num(obj(m)["quantity"]),
      })),
    },
    limits: arr(d["limits"]).map((l) => ({
      limitCode: str(obj(l)["limit_code"]),
      limitValue: numOrNull(obj(l)["limit_value"]),
      planValue: numOrNull(obj(l)["plan_value"]),
    })),
    features: arr(d["features"]).map((f) => ({
      featureCode: str(obj(f)["feature_code"]),
      enabled: bool(obj(f)["enabled"]),
      inPlan: bool(obj(f)["in_plan"]),
    })),
    flags: arr(d["flags"]).map(parseFlag),
    planOverrides: arr(d["plan_overrides"]).map(parsePlanOverride),
    owners: arr(d["owners"]).map((o) => ({
      name: strOrNull(obj(o)["name"]),
      email: strOrNull(obj(o)["email"]),
    })),
    supportSessions: arr(d["support_sessions"]).map((s) => {
      const r = obj(s);
      return {
        id: str(r["id"]),
        reason: str(r["reason"]),
        startsAt: str(r["starts_at"]),
        endsAt: str(r["ends_at"]),
        endedAt: strOrNull(r["ended_at"]),
        granteeOrgName: strOrNull(r["grantee_org_name"]),
        open: bool(r["open"]),
      };
    }),
  };
}

/** One org's billing and identity facts; never its records. The view is logged. */
export async function getOrgDetail(db: XosClient, orgId: string): Promise<Result<OrgDetail>> {
  return rpc(db, "console_org_detail", { p_org_id: orgId }, parseOrgDetail);
}

// Plan overrides --------------------------------------------------------------------------------------------------------

export type PlanOverrideChange =
  | { readonly kind: "Plan"; readonly planCode: string }
  | { readonly kind: "Feature"; readonly featureCode: string; readonly enabled: boolean }
  | { readonly kind: "Limit"; readonly limitCode: string; readonly limitValue: number | null };

export async function setPlanOverride(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly change: PlanOverrideChange;
    readonly reason: string;
    readonly expiresAt: string;
  },
): Promise<Result<string>> {
  const c = input.change;
  return rpc(
    db,
    "console_set_plan_override",
    {
      p_org_id: input.orgId,
      p_kind: c.kind,
      p_plan_code: c.kind === "Plan" ? c.planCode : null,
      p_feature_code: c.kind === "Feature" ? c.featureCode : null,
      p_feature_enabled: c.kind === "Feature" ? c.enabled : null,
      p_limit_code: c.kind === "Limit" ? c.limitCode : null,
      p_limit_value: c.kind === "Limit" ? c.limitValue : null,
      p_reason: input.reason,
      p_expires_at: input.expiresAt,
    },
    str,
  );
}

export async function endPlanOverride(
  db: XosClient,
  overrideId: string,
  reason: string,
): Promise<Result<string>> {
  return rpc(db, "console_end_plan_override", { p_override_id: overrideId, p_reason: reason }, str);
}

// Feature flags ----------------------------------------------------------------------------------------------------------

export interface FlagSummary {
  readonly flagKey: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly requiredPlanFeature: string | null;
  readonly killSwitch: boolean;
  readonly overridesOn: number;
  readonly overridesOff: number;
}

export async function listFlags(db: XosClient): Promise<Result<FlagSummary[]>> {
  return rpc(db, "console_flags", {}, (data) =>
    arr(data).map((d) => {
      const r = obj(d);
      return {
        flagKey: str(r["flag_key"]),
        description: str(r["description"]),
        defaultEnabled: bool(r["default_enabled"]),
        requiredPlanFeature: strOrNull(r["required_plan_feature"]),
        killSwitch: bool(r["kill_switch"]),
        overridesOn: num(r["overrides_on"]),
        overridesOff: num(r["overrides_off"]),
      };
    }),
  );
}

export async function setFlagOverride(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly flagKey: string;
    readonly enabled: boolean;
    readonly reason: string;
    readonly expiresAt: string;
  },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_set_flag_override",
    {
      p_org_id: input.orgId,
      p_flag_key: input.flagKey,
      p_enabled: input.enabled,
      p_reason: input.reason,
      p_expires_at: input.expiresAt,
    },
    str,
  );
}

export async function clearFlagOverride(
  db: XosClient,
  overrideId: string,
  reason: string,
): Promise<Result<string>> {
  return rpc(
    db,
    "console_clear_flag_override",
    { p_override_id: overrideId, p_reason: reason },
    str,
  );
}

export async function setKillSwitch(
  db: XosClient,
  input: { readonly flagKey: string; readonly kill: boolean; readonly reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_set_kill_switch",
    { p_flag_key: input.flagKey, p_kill: input.kill, p_reason: input.reason },
    str,
  );
}

// Platform support sessions ----------------------------------------------------------------------------------------------

export type SupportArea = "Overview" | "Members" | "Projects" | "Settings";
export const SUPPORT_AREAS: readonly SupportArea[] = [
  "Overview",
  "Members",
  "Projects",
  "Settings",
];

export interface OpenSupportSession {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly reason: string;
  readonly grantedByName: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

export async function listOpenSupportSessions(
  db: XosClient,
): Promise<Result<OpenSupportSession[]>> {
  return rpc(db, "console_support_sessions", {}, (data) =>
    arr(data).map((d) => {
      const r = obj(d);
      return {
        id: str(r["id"]),
        orgId: str(r["org_id"]),
        orgName: str(r["org_name"]),
        orgSlug: str(r["org_slug"]),
        reason: str(r["reason"]),
        grantedByName: strOrNull(r["granted_by_name"]),
        startsAt: str(r["starts_at"]),
        endsAt: str(r["ends_at"]),
      };
    }),
  );
}

export type SupportAreaData =
  | {
      readonly area: "Overview";
      readonly counts: {
        readonly members: number;
        readonly projects: number;
        readonly activeProjects: number;
        readonly workspaces: number;
        readonly settings: number;
        readonly openTickets: number;
      };
    }
  | {
      readonly area: "Members";
      readonly members: readonly {
        readonly name: string | null;
        readonly email: string | null;
        readonly roles: readonly string[];
        readonly joined: string;
        readonly ends: string | null;
      }[];
    }
  | {
      readonly area: "Projects";
      readonly projects: readonly {
        readonly key: string;
        readonly name: string;
        readonly state: string;
        readonly phase: string;
        readonly startsOn: string | null;
        readonly endsOn: string | null;
        readonly timeZone: string;
        readonly archived: boolean;
      }[];
    }
  | {
      readonly area: "Settings";
      readonly settings: readonly {
        readonly key: string;
        readonly value: string | null;
        readonly locked: boolean;
      }[];
    };

export interface SupportView {
  readonly org: { readonly id: string; readonly name: string; readonly slug: string };
  readonly session: {
    readonly id: string;
    readonly reason: string;
    readonly startsAt: string;
    readonly endsAt: string;
  };
  readonly data: SupportAreaData;
}

/** Parses app.console_support_view's document. */
export function parseSupportView(raw: unknown): SupportView {
  const d = obj(raw);
  const org = obj(d["org"]);
  const session = obj(d["session"]);
  const area = SUPPORT_AREAS.find((a) => a === d["area"]) ?? "Overview";
  const data = d["data"];
  let parsed: SupportAreaData;
  if (area === "Members") {
    parsed = {
      area,
      members: arr(data).map((m) => {
        const r = obj(m);
        return {
          name: strOrNull(r["name"]),
          email: strOrNull(r["email"]),
          roles: arr(r["roles"]).map(str),
          joined: str(r["joined"]),
          ends: strOrNull(r["ends"]),
        };
      }),
    };
  } else if (area === "Projects") {
    parsed = {
      area,
      projects: arr(data).map((p) => {
        const r = obj(p);
        return {
          key: str(r["key"]),
          name: str(r["name"]),
          state: str(r["state"]),
          phase: str(r["phase"]),
          startsOn: strOrNull(r["starts_on"]),
          endsOn: strOrNull(r["ends_on"]),
          timeZone: str(r["time_zone"]),
          archived: bool(r["archived"]),
        };
      }),
    };
  } else if (area === "Settings") {
    parsed = {
      area,
      settings: arr(data).map((s) => ({
        key: str(obj(s)["key"]),
        value: strOrNull(obj(s)["value"]),
        locked: bool(obj(s)["locked"]),
      })),
    };
  } else {
    const c = obj(data);
    parsed = {
      area: "Overview",
      counts: {
        members: num(c["members"]),
        projects: num(c["projects"]),
        activeProjects: num(c["active_projects"]),
        workspaces: num(c["workspaces"]),
        settings: num(c["settings"]),
        openTickets: num(c["open_tickets"]),
      },
    };
  }
  return {
    org: { id: str(org["id"]), name: str(org["name"]), slug: str(org["slug"]) },
    session: {
      id: str(session["id"]),
      reason: str(session["reason"]),
      startsAt: str(session["starts_at"]),
      endsAt: str(session["ends_at"]),
    },
    data: parsed,
  };
}

/** Opens one area of an org during its platform support session; the org sees the access. */
export async function openSupportArea(
  db: XosClient,
  sessionId: string,
  area: SupportArea,
): Promise<Result<SupportView>> {
  return rpc(
    db,
    "console_support_view",
    { p_support_session_id: sessionId, p_area: area },
    parseSupportView,
  );
}

/** Ends a support session early (the operator for a platform session; the Owner either kind). */
export async function endSupportSession(db: XosClient, sessionId: string): Promise<Result<string>> {
  return rpc(db, "end_support_session", { p_support_session_id: sessionId }, str);
}

// Moderation ------------------------------------------------------------------------------------------------------------

export type ModerationAction = "Removed" | "Restricted" | "Restored" | "No Action";
export type ModerationGround = "Illegal Content" | "Terms Violation" | "No Violation";
export type AppealState = "Open" | "Upheld" | "Reversed";

export interface QueueRow {
  readonly opportunityId: string;
  readonly title: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly state: string;
  readonly removed: boolean;
  readonly openReports: number;
  readonly totalReports: number;
  readonly openAppeals: number;
  readonly reasons: readonly string[];
  readonly firstReportedAt: string | null;
  readonly lastDecision: ModerationAction | null;
  readonly lastDecidedAt: string | null;
}

export async function getModerationQueue(db: XosClient, open = true): Promise<Result<QueueRow[]>> {
  return rpc(db, "console_moderation_queue", { p_open: open }, (data) =>
    arr(data).map((d) => {
      const r = obj(d);
      return {
        opportunityId: str(r["opportunity_id"]),
        title: str(r["title"]),
        orgId: str(r["org_id"]),
        orgName: str(r["org_name"]),
        state: str(r["opportunity_state"]),
        removed: bool(r["removed"]),
        openReports: num(r["open_reports"]),
        totalReports: num(r["total_reports"]),
        openAppeals: num(r["open_appeals"]),
        reasons: arr(r["reasons"]).map(str),
        firstReportedAt: strOrNull(r["first_reported_at"]),
        lastDecision: strOrNull(r["last_decision"]) as ModerationAction | null,
        lastDecidedAt: strOrNull(r["last_decided_at"]),
      };
    }),
  );
}

export interface ListingDetail {
  readonly listing: {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly roleType: string;
    readonly visibility: string;
    readonly state: string;
    readonly startsOn: string | null;
    readonly endsOn: string | null;
    readonly removed: boolean;
    readonly deleted: boolean;
    readonly org: { readonly id: string; readonly name: string; readonly slug: string };
    readonly projectName: string | null;
  };
  readonly reports: readonly {
    readonly id: string;
    readonly reason: string;
    readonly details: string | null;
    readonly reportedAt: string;
    readonly reporterName: string | null;
    readonly open: boolean;
  }[];
  readonly decisions: readonly {
    readonly id: string;
    readonly action: ModerationAction;
    readonly ground: ModerationGround | null;
    readonly ruleReference: string | null;
    readonly facts: string | null;
    readonly statement: string;
    readonly decidedAt: string;
    readonly decidedByName: string | null;
    readonly automatedDetection: boolean;
    readonly automatedDecision: boolean;
    readonly appealId: string | null;
  }[];
  readonly appeals: readonly {
    readonly id: string;
    readonly decisionId: string;
    readonly decision: ModerationAction;
    readonly grounds: string;
    readonly state: AppealState;
    readonly filedAt: string;
    readonly appellantName: string | null;
    readonly decidedByName: string | null;
    readonly decisionStatement: string | null;
    readonly decidedAt: string | null;
    /** Whether the signed-in operator may decide it: open, and not their own decision. */
    readonly decidableByMe: boolean;
  }[];
}

/** Parses app.console_listing_detail's document. */
export function parseListingDetail(raw: unknown): ListingDetail {
  const d = obj(raw);
  const l = obj(d["listing"]);
  const org = obj(l["org"]);
  return {
    listing: {
      id: str(l["id"]),
      title: str(l["title"]),
      description: strOrNull(l["description"]),
      roleType: str(l["role_type"]),
      visibility: str(l["visibility"]),
      state: str(l["state"]),
      startsOn: strOrNull(l["starts_on"]),
      endsOn: strOrNull(l["ends_on"]),
      removed: bool(l["removed"]),
      deleted: bool(l["deleted"]),
      org: { id: str(org["id"]), name: str(org["name"]), slug: str(org["slug"]) },
      projectName: strOrNull(l["project"]),
    },
    reports: arr(d["reports"]).map((x) => {
      const r = obj(x);
      return {
        id: str(r["id"]),
        reason: str(r["reason"]),
        details: strOrNull(r["details"]),
        reportedAt: str(r["reported_at"]),
        reporterName: strOrNull(r["reporter_name"]),
        open: bool(r["open"]),
      };
    }),
    decisions: arr(d["decisions"]).map((x) => {
      const r = obj(x);
      return {
        id: str(r["id"]),
        action: str(r["action"]) as ModerationAction,
        ground: strOrNull(r["ground"]) as ModerationGround | null,
        ruleReference: strOrNull(r["rule_reference"]),
        facts: strOrNull(r["facts"]),
        statement: str(r["statement"]),
        decidedAt: str(r["decided_at"]),
        decidedByName: strOrNull(r["decided_by_name"]),
        automatedDetection: bool(r["automated_detection"]),
        automatedDecision: bool(r["automated_decision"]),
        appealId: strOrNull(r["appeal_id"]),
      };
    }),
    appeals: arr(d["appeals"]).map((x) => {
      const r = obj(x);
      return {
        id: str(r["id"]),
        decisionId: str(r["moderation_action_id"]),
        decision: str(r["decision"]) as ModerationAction,
        grounds: str(r["grounds"]),
        state: str(r["state"]) as AppealState,
        filedAt: str(r["filed_at"]),
        appellantName: strOrNull(r["appellant_name"]),
        decidedByName: strOrNull(r["decided_by_name"]),
        decisionStatement: strOrNull(r["decision_statement"]),
        decidedAt: strOrNull(r["decided_at"]),
        decidableByMe: bool(r["decidable_by_me"]),
      };
    }),
  };
}

export async function getListingDetail(
  db: XosClient,
  opportunityId: string,
): Promise<Result<ListingDetail>> {
  return rpc(db, "console_listing_detail", { p_opportunity_id: opportunityId }, parseListingDetail);
}

export interface StatementOfReasons {
  readonly action: ModerationAction;
  readonly ground: ModerationGround;
  readonly ruleReference: string;
  readonly facts: string;
  readonly statement: string;
}

/** The ground a moderation action fits: removing or restricting needs a violation, the rest none. */
export function groundsFor(action: ModerationAction): readonly ModerationGround[] {
  return action === "Removed" || action === "Restricted"
    ? ["Terms Violation", "Illegal Content"]
    : ["No Violation"];
}

export async function decideListing(
  db: XosClient,
  input: StatementOfReasons & { readonly opportunityId: string; readonly reportId?: string | null },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_decide_listing",
    {
      p_opportunity_id: input.opportunityId,
      p_action: input.action,
      p_ground: input.ground,
      p_rule_reference: input.ruleReference,
      p_facts: input.facts,
      p_statement: input.statement,
      p_listing_report_id: input.reportId ?? null,
    },
    str,
  );
}

export async function decideAppeal(
  db: XosClient,
  input: {
    readonly appealId: string;
    readonly outcome: "Upheld" | "Reversed";
    readonly statement: string;
    /** Required when reversing a decision to take no action: the new decision. */
    readonly newDecision?: Omit<StatementOfReasons, "statement"> | null;
  },
): Promise<Result<string>> {
  const n = input.newDecision ?? null;
  return rpc(
    db,
    "console_decide_appeal",
    {
      p_appeal_id: input.appealId,
      p_outcome: input.outcome,
      p_statement: input.statement,
      p_action: n?.action ?? null,
      p_ground: n?.ground ?? null,
      p_rule_reference: n?.ruleReference ?? null,
      p_facts: n?.facts ?? null,
    },
    str,
  );
}

// System banners ---------------------------------------------------------------------------------------------------------

export type BannerAudience = "Everyone" | "Atlas" | "Gateway" | "Compass";

export interface ConsoleBanner {
  readonly id: string;
  readonly kind: "Maintenance" | "Incident" | "Plan Notice" | "Notice";
  readonly severity: "Info" | "Warning" | "Critical";
  readonly audience: BannerAudience;
  readonly message: string;
  readonly messageEs: string | null;
  readonly linkUrl: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly dismissible: boolean;
  readonly endedAt: string | null;
  readonly live: boolean;
  readonly createdByName: string | null;
  readonly createdAt: string;
}

export async function listBanners(db: XosClient): Promise<Result<ConsoleBanner[]>> {
  return rpc(db, "console_banners", {}, (data) =>
    arr(data).map((d) => {
      const r = obj(d);
      return {
        id: str(r["id"]),
        kind: str(r["banner_kind"]) as ConsoleBanner["kind"],
        severity: str(r["severity"]) as ConsoleBanner["severity"],
        audience: str(r["audience"]) as BannerAudience,
        message: str(r["message"]),
        messageEs: strOrNull(r["message_es"]),
        linkUrl: strOrNull(r["link_url"]),
        startsAt: str(r["starts_at"]),
        endsAt: strOrNull(r["ends_at"]),
        dismissible: bool(r["dismissible"]),
        endedAt: strOrNull(r["ended_at"]),
        live: bool(r["live"]),
        createdByName: strOrNull(r["created_by_name"]),
        createdAt: str(r["created_at"]),
      };
    }),
  );
}

export async function saveBanner(
  db: XosClient,
  input: {
    readonly id?: string | null;
    readonly kind: ConsoleBanner["kind"];
    readonly severity: ConsoleBanner["severity"];
    readonly audience: BannerAudience;
    readonly message: string;
    readonly messageEs?: string | null;
    readonly linkUrl?: string | null;
    readonly startsAt?: string | null;
    readonly endsAt?: string | null;
    readonly dismissible: boolean;
  },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_save_banner",
    {
      p_banner_id: input.id ?? null,
      p_kind: input.kind,
      p_severity: input.severity,
      p_audience: input.audience,
      p_message: input.message,
      p_message_es: input.messageEs ?? null,
      p_link_url: input.linkUrl ?? null,
      p_starts_at: input.startsAt ?? null,
      p_ends_at: input.endsAt ?? null,
      p_dismissible: input.dismissible,
    },
    str,
  );
}

export async function endBanner(db: XosClient, bannerId: string): Promise<Result<string>> {
  return rpc(db, "console_end_banner", { p_banner_id: bannerId }, str);
}

// The platform team ----------------------------------------------------------------------------------------------------

export interface OperatorGrant {
  readonly id: string;
  readonly personId: string;
  readonly fullName: string | null;
  readonly email: string | null;
  readonly role: OperatorRole;
  readonly reason: string;
  readonly grantedByName: string | null;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
  readonly revokedByName: string | null;
  readonly revokeReason: string | null;
}

export async function listOperators(db: XosClient): Promise<Result<OperatorGrant[]>> {
  return rpc(db, "console_operators", {}, (data) =>
    arr(data).map((d) => {
      const r = obj(d);
      return {
        id: str(r["id"]),
        personId: str(r["person_id"]),
        fullName: strOrNull(r["full_name"]),
        email: strOrNull(r["email"]),
        role: str(r["operator_role"]) as OperatorRole,
        reason: str(r["reason"]),
        grantedByName: strOrNull(r["granted_by_name"]),
        grantedAt: str(r["granted_at"]),
        revokedAt: strOrNull(r["revoked_at"]),
        revokedByName: strOrNull(r["revoked_by_name"]),
        revokeReason: strOrNull(r["revoke_reason"]),
      };
    }),
  );
}

export async function grantOperator(
  db: XosClient,
  input: { readonly email: string; readonly role: OperatorRole; readonly reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_grant_operator",
    { p_email: input.email.trim(), p_role: input.role, p_reason: input.reason },
    str,
  );
}

export async function revokeOperator(
  db: XosClient,
  grantId: string,
  reason: string,
): Promise<Result<string>> {
  return rpc(db, "console_revoke_operator", { p_operator_id: grantId, p_reason: reason }, str);
}

export interface ConsoleAction {
  readonly id: string;
  readonly operatorName: string | null;
  readonly action: string;
  readonly targetOrgId: string | null;
  readonly targetOrgName: string | null;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
  readonly reason: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly actedAt: string;
}

export async function listActionLog(
  db: XosClient,
  input: { readonly orgId?: string | null; readonly limit?: number } = {},
): Promise<Result<ConsoleAction[]>> {
  return rpc(
    db,
    "console_action_log",
    { p_target_org_id: input.orgId ?? null, p_limit: input.limit ?? 100 },
    (data) =>
      arr(data).map((d) => {
        const r = obj(d);
        return {
          id: str(r["id"]),
          operatorName: strOrNull(r["operator_name"]),
          action: str(r["action"]),
          targetOrgId: strOrNull(r["target_org_id"]),
          targetOrgName: strOrNull(r["target_org_name"]),
          subjectTable: strOrNull(r["subject_table"]),
          subjectId: strOrNull(r["subject_id"]),
          reason: strOrNull(r["reason"]),
          details: obj(r["details"]),
          actedAt: str(r["acted_at"]),
        };
      }),
  );
}

/** A refusal the console names in copy, or the error kind for anything else. */
export function consoleErrorKey(error: { readonly kind: string; readonly rule?: string }): string {
  return error.kind === "refusal" && error.rule ? error.rule : error.kind;
}
