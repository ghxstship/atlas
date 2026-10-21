import { describe, expect, it } from "vitest";
import {
  can,
  clearFlagOverride,
  consoleErrorKey,
  decideAppeal,
  decideListing,
  endBanner,
  endPlanOverride,
  endSupportSession,
  getListingDetail,
  getModerationQueue,
  getOperator,
  getOrgDetail,
  grantOperator,
  groundsFor,
  listActionLog,
  listBanners,
  listFlags,
  listOpenSupportSessions,
  listOperators,
  openSupportArea,
  parseSupportView,
  revokeOperator,
  saveBanner,
  searchOrgs,
  setFlagOverride,
  setKillSwitch,
  setPlanOverride,
} from "../src/console.ts";
import {
  appealDeadline,
  canAppeal,
  fileModerationAppeal,
  grantPlatformSupportSession,
  hasAppealable,
  listModerationDecisions,
  listPlatformSupportSessions,
  listSupportAccessLog,
} from "../src/platform-support.ts";
import {
  addDismissed,
  bannerText,
  bannerTone,
  createBannerCache,
  listActiveSystemBanners,
  parseBanners,
  parseDismissed,
  visibleBanners,
  type BannerClient,
  type SystemBanner,
} from "../src/system-banners.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const denied = {
  data: null,
  error: { code: "42501", message: "the operator console is for the platform team" },
};

describe("operator console: who is signed in", () => {
  it("reads the operator, their permissions and the second factor", async () => {
    const { db } = moduleClient({
      "rpc:console_whoami": [
        ok([
          {
            person_id: "p1",
            full_name: "Olga Brandt",
            email: "olga@platform.test",
            operator_role: "Administrator",
            permissions: ["tenants.read", "plans.write", "not.a.permission"],
            second_factor: true,
          },
        ]),
        ok([]),
        denied,
      ],
    });
    const operator = await getOperator(db);
    expect(operator).toEqual({
      ok: true,
      data: {
        personId: "p1",
        fullName: "Olga Brandt",
        email: "olga@platform.test",
        role: "Administrator",
        permissions: ["tenants.read", "plans.write"],
        secondFactor: true,
      },
    });
    expect(can(operator.ok ? operator.data : null, "plans.write")).toBe(true);
    expect(can(operator.ok ? operator.data : null, "operators.manage")).toBe(false);
    expect(can(null, "tenants.read")).toBe(false);
    expect(await getOperator(db)).toEqual({ ok: true, data: null });
    expect(await getOperator(db)).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("names refusals by their rule and other errors by kind", () => {
    expect(consoleErrorKey({ kind: "refusal", rule: "step_up_required" })).toBe("step_up_required");
    expect(consoleErrorKey({ kind: "not-found" })).toBe("not-found");
  });
});

describe("operator console: tenants", () => {
  it("searches orgs and passes the query, plan and limit", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_search_orgs": [
        ok([
          {
            org_id: "o1",
            name: "Northwind Live",
            slug: "northwind-live",
            plan_code: "team",
            subscription_plan_code: "team",
            subscription_state: "active",
            owner_name: "Alice Moreno",
            owner_email: "alice@northwind.test",
            seats: 7,
            canceled: false,
            parent_org_name: null,
            created_at: "2026-10-01T00:00:00Z",
          },
        ]),
        ok(null),
      ],
    });
    const result = await searchOrgs(db, { query: "  north ", planCode: "team" });
    expect(result.ok && result.data[0]).toMatchObject({
      slug: "northwind-live",
      seats: 7,
      ownerEmail: "alice@northwind.test",
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_query: "north",
      p_plan_code: "team",
      p_limit: 50,
    });
    expect(await searchOrgs(db)).toEqual({ ok: true, data: [] });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toEqual({
      p_query: null,
      p_plan_code: null,
      p_limit: 50,
    });
  });

  it("parses the org detail document", async () => {
    const { db } = moduleClient({
      "rpc:console_org_detail": [
        ok({
          org: {
            id: "o1",
            name: "Harbor Lights",
            slug: "harbor-lights",
            created_at: "2026-10-01T00:00:00Z",
            parent: { id: "p", name: "Bluewater", slug: "bluewater" },
            client_count: 0,
          },
          plan: {
            plan_code: "pro",
            subscription: {
              plan_code: "access",
              state: "active",
              extra_seats: 2,
              grandfathered: false,
              since: "2026-10-01T00:00:00Z",
            },
          },
          status: {
            read_only: true,
            cancellation: { canceled_at: "a", read_only_until: "b", purge_after: "c" },
          },
          usage: {
            seats: 3,
            field_members: 1,
            active_projects: 2,
            month_start: "2026-10-01T00:00:00Z",
            meters: [{ meter_code: "aurora_requests", quantity: 12 }],
          },
          limits: [{ limit_code: "seats", limit_value: null, plan_value: 15 }],
          features: [{ feature_code: "api_keys", enabled: false, in_plan: true }],
          flags: [
            {
              flag_key: "imports.ai_mapping",
              description: "AI mapping.",
              default_enabled: false,
              kill_switch: false,
              required_plan_feature: null,
              enabled: true,
              override: {
                id: "f1",
                enabled: true,
                reason: "Pilot.",
                expires_at: "2026-11-01T00:00:00Z",
                set_by: "Omar",
                set_at: "2026-10-20T00:00:00Z",
                live: true,
              },
            },
            {
              flag_key: "webhooks.delivery",
              description: "Webhooks.",
              default_enabled: true,
              kill_switch: false,
              required_plan_feature: "webhooks",
              enabled: true,
              override: null,
            },
          ],
          plan_overrides: [
            {
              id: "po1",
              kind: "Plan",
              plan_code: "pro",
              feature_code: null,
              feature_enabled: null,
              limit_code: null,
              limit_value: null,
              reason: "Pilot.",
              starts_at: "s",
              expires_at: "e",
              ended_at: null,
              end_reason: null,
              set_by: "Olga",
              live: true,
            },
          ],
          owners: [{ name: "Xavier Dubois", email: "xavier@harborlights.test" }],
          support_sessions: [
            {
              id: "s1",
              reason: "Help.",
              starts_at: "s",
              ends_at: "e",
              ended_at: null,
              grantee_org_name: null,
              open: true,
            },
          ],
        }),
      ],
    });
    const result = await getOrgDetail(db, "o1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.planCode).toBe("pro");
    expect(result.data.subscription?.planCode).toBe("access");
    expect(result.data.cancellation?.readOnlyUntil).toBe("b");
    expect(result.data.usage.meters).toEqual([{ meterCode: "aurora_requests", quantity: 12 }]);
    expect(result.data.limits[0]).toEqual({ limitCode: "seats", limitValue: null, planValue: 15 });
    expect(result.data.flags[0]?.override?.reason).toBe("Pilot.");
    expect(result.data.flags[1]?.override).toBeNull();
    expect(result.data.planOverrides[0]?.live).toBe(true);
    expect(result.data.org.parent?.slug).toBe("bluewater");
    expect(result.data.supportSessions[0]?.open).toBe(true);
  });
});

describe("operator console: plans and flags", () => {
  it("sends each kind of plan override and ends one", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_set_plan_override": [ok("po1"), ok("po2"), refused("plan_override_expiry")],
      "rpc:console_end_plan_override": [ok("po1")],
    });
    const base = { orgId: "o1", reason: "Pilot.", expiresAt: "2026-11-01T00:00:00Z" };
    expect(
      await setPlanOverride(db, { ...base, change: { kind: "Plan", planCode: "pro" } }),
    ).toEqual({ ok: true, data: "po1" });
    expect(
      await setPlanOverride(db, {
        ...base,
        change: { kind: "Feature", featureCode: "api_keys", enabled: false },
      }),
    ).toEqual({ ok: true, data: "po2" });
    expect(
      await setPlanOverride(db, {
        ...base,
        change: { kind: "Limit", limitCode: "seats", limitValue: null },
      }),
    ).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "plan_override_expiry", message: "Refused." },
    });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({
      p_kind: "Feature",
      p_feature_code: "api_keys",
      p_feature_enabled: false,
      p_plan_code: null,
    });
    expect(stepsOf(calls[2], "args")[0]?.[0]).toMatchObject({
      p_kind: "Limit",
      p_limit_code: "seats",
      p_limit_value: null,
    });
    expect(await endPlanOverride(db, "po1", "Done.")).toEqual({ ok: true, data: "po1" });
  });

  it("lists flags and sets, clears and kills them", async () => {
    const { db } = moduleClient({
      "rpc:console_flags": [
        ok([
          {
            flag_key: "imports.ai_mapping",
            description: "AI.",
            default_enabled: false,
            required_plan_feature: null,
            kill_switch: false,
            overrides_on: 2,
            overrides_off: 0,
          },
        ]),
      ],
      "rpc:console_set_flag_override": [ok("f1")],
      "rpc:console_clear_flag_override": [ok("f1")],
      "rpc:console_set_kill_switch": [ok("imports.ai_mapping")],
    });
    const flags = await listFlags(db);
    expect(flags.ok && flags.data[0]?.overridesOn).toBe(2);
    expect(
      await setFlagOverride(db, {
        orgId: "o1",
        flagKey: "imports.ai_mapping",
        enabled: true,
        reason: "Pilot.",
        expiresAt: "x",
      }),
    ).toEqual({ ok: true, data: "f1" });
    expect(await clearFlagOverride(db, "f1", "Done.")).toEqual({ ok: true, data: "f1" });
    expect(
      await setKillSwitch(db, { flagKey: "imports.ai_mapping", kill: true, reason: "Incident." }),
    ).toEqual({ ok: true, data: "imports.ai_mapping" });
  });
});

describe("operator console: support sessions", () => {
  it("lists open sessions, opens each area and ends a session", async () => {
    const session = { id: "s1", reason: "Imports fail.", starts_at: "a", ends_at: "b" };
    const org = { id: "o1", name: "Northwind Live", slug: "northwind-live" };
    const { db } = moduleClient({
      "rpc:console_support_sessions": [
        ok([
          {
            id: "s1",
            org_id: "o1",
            org_name: "Northwind Live",
            org_slug: "northwind-live",
            reason: "Imports fail.",
            granted_by_name: "Alice",
            starts_at: "a",
            ends_at: "b",
          },
        ]),
      ],
      "rpc:console_support_view": [
        ok({
          org,
          session,
          area: "Members",
          data: [
            {
              name: "Alice",
              email: "alice@northwind.test",
              roles: ["owner"],
              joined: "j",
              ends: null,
            },
          ],
        }),
        ok({
          org,
          session,
          area: "Projects",
          data: [
            {
              key: "NWS",
              name: "Summer",
              state: "Active",
              phase: "SCP",
              starts_on: null,
              ends_on: null,
              time_zone: "America/New_York",
              archived: false,
            },
          ],
        }),
        ok({
          org,
          session,
          area: "Settings",
          data: [{ key: "general.locale", value: "en-US", locked: false }],
        }),
        ok({
          org,
          session,
          area: "Overview",
          data: {
            members: 7,
            projects: 1,
            active_projects: 1,
            workspaces: 1,
            settings: 3,
            open_tickets: 0,
          },
        }),
        refused("support_session_closed"),
      ],
      "rpc:end_support_session": [ok("s1")],
    });
    const open = await listOpenSupportSessions(db);
    expect(open.ok && open.data[0]?.grantedByName).toBe("Alice");
    const members = await openSupportArea(db, "s1", "Members");
    expect(
      members.ok && members.data.data.area === "Members" && members.data.data.members[0]?.roles,
    ).toEqual(["owner"]);
    const projects = await openSupportArea(db, "s1", "Projects");
    expect(
      projects.ok && projects.data.data.area === "Projects" && projects.data.data.projects[0]?.key,
    ).toBe("NWS");
    const settings = await openSupportArea(db, "s1", "Settings");
    expect(
      settings.ok &&
        settings.data.data.area === "Settings" &&
        settings.data.data.settings[0]?.value,
    ).toBe("en-US");
    const overview = await openSupportArea(db, "s1", "Overview");
    expect(
      overview.ok && overview.data.data.area === "Overview" && overview.data.data.counts.members,
    ).toBe(7);
    expect((await openSupportArea(db, "s1", "Members")).ok).toBe(false);
    expect(await endSupportSession(db, "s1")).toEqual({ ok: true, data: "s1" });
    expect(parseSupportView({}).data.area).toBe("Overview");
  });
});

describe("operator console: moderation", () => {
  it("reads the queue and a listing, and decides listings and appeals", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_moderation_queue": [
        ok([
          {
            opportunity_id: "op1",
            title: "Riggers",
            org_id: "o1",
            org_name: "Northwind",
            opportunity_state: "Published",
            removed: false,
            open_reports: 2,
            total_reports: 2,
            open_appeals: 0,
            reasons: ["Fraud"],
            first_reported_at: "r",
            last_decision: null,
            last_decided_at: null,
          },
        ]),
      ],
      "rpc:console_listing_detail": [
        ok({
          listing: {
            id: "op1",
            title: "Riggers",
            description: null,
            role_type: "Crew",
            visibility: "Public",
            state: "Published",
            starts_on: null,
            ends_on: null,
            removed: true,
            deleted: false,
            org: { id: "o1", name: "Northwind", slug: "northwind-live" },
            project: "Summer",
          },
          reports: [
            {
              id: "r1",
              reason: "Fraud",
              details: "Fee.",
              reported_at: "t",
              reporter_name: "Quinn",
              open: false,
            },
          ],
          decisions: [
            {
              id: "d1",
              action: "Removed",
              ground: "Terms Violation",
              rule_reference: "AUP 3.2",
              facts: "Fee.",
              statement: "Removed.",
              decided_at: "t",
              decided_by: "p",
              decided_by_name: "Tess",
              automated_detection: false,
              automated_decision: false,
              listing_report_id: "r1",
              appeal_id: null,
            },
          ],
          appeals: [
            {
              id: "a1",
              moderation_action_id: "d1",
              decision: "Removed",
              grounds: "Legal fee.",
              state: "Open",
              filed_at: "t",
              appellant_name: "Carol",
              decided_by_name: null,
              decision_statement: null,
              decided_at: null,
              decidable_by_me: true,
            },
          ],
        }),
      ],
      "rpc:console_decide_listing": [ok("d1")],
      "rpc:console_decide_appeal": [ok("a1"), ok("a2")],
    });
    const queue = await getModerationQueue(db);
    expect(queue.ok && queue.data[0]?.openReports).toBe(2);
    const detail = await getListingDetail(db, "op1");
    expect(detail.ok && detail.data.decisions[0]?.ruleReference).toBe("AUP 3.2");
    expect(detail.ok && detail.data.appeals[0]?.decidableByMe).toBe(true);
    expect(
      await decideListing(db, {
        opportunityId: "op1",
        action: "Removed",
        ground: "Terms Violation",
        ruleReference: "AUP 3.2",
        facts: "Fee.",
        statement: "Removed.",
      }),
    ).toEqual({ ok: true, data: "d1" });
    expect(stepsOf(calls[2], "args")[0]?.[0]).toMatchObject({
      p_listing_report_id: null,
      p_ground: "Terms Violation",
    });
    expect(
      await decideAppeal(db, { appealId: "a1", outcome: "Upheld", statement: "Stands." }),
    ).toEqual({ ok: true, data: "a1" });
    expect(stepsOf(calls[3], "args")[0]?.[0]).toMatchObject({ p_action: null, p_facts: null });
    await decideAppeal(db, {
      appealId: "a2",
      outcome: "Reversed",
      statement: "Remove.",
      newDecision: {
        action: "Removed",
        ground: "Illegal Content",
        ruleReference: "Law",
        facts: "Facts.",
      },
    });
    expect(stepsOf(calls[4], "args")[0]?.[0]).toMatchObject({
      p_action: "Removed",
      p_ground: "Illegal Content",
    });
    expect(groundsFor("Removed")).toEqual(["Terms Violation", "Illegal Content"]);
    expect(groundsFor("No Action")).toEqual(["No Violation"]);
  });
});

describe("operator console: banners, roster and ledger", () => {
  it("lists, saves and ends banners", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_banners": [
        ok([
          {
            id: "b1",
            banner_kind: "Maintenance",
            severity: "Warning",
            audience: "Everyone",
            message: "Tonight.",
            message_es: null,
            link_url: null,
            starts_at: "s",
            ends_at: "e",
            dismissible: true,
            ended_at: null,
            live: true,
            created_by_name: "Omar",
            created_at: "c",
          },
        ]),
      ],
      "rpc:console_save_banner": [ok("b1")],
      "rpc:console_end_banner": [ok("b1")],
    });
    const banners = await listBanners(db);
    expect(banners.ok && banners.data[0]?.state).toBe("Live");
    expect(
      await saveBanner(db, {
        kind: "Notice",
        severity: "Info",
        audience: "Atlas",
        message: "Hi.",
        dismissible: true,
      }),
    ).toEqual({ ok: true, data: "b1" });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({
      p_banner_id: null,
      p_starts_at: null,
      p_message_es: null,
    });
    expect(await endBanner(db, "b1")).toEqual({ ok: true, data: "b1" });
  });

  it("manages the roster and reads the console ledger", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_operators": [
        ok([
          {
            id: "g1",
            person_id: "p1",
            full_name: "Omar",
            email: "omar@platform.test",
            operator_role: "Support",
            reason: "Launch.",
            granted_by_name: "Olga",
            granted_at: "t",
            revoked_at: null,
            revoked_by_name: null,
            revoke_reason: null,
          },
        ]),
      ],
      "rpc:console_grant_operator": [ok("g2")],
      "rpc:console_revoke_operator": [ok("g1")],
      "rpc:console_action_log": [
        ok([
          {
            id: "l1",
            operator_name: "Olga",
            action: "plan_override.set",
            target_org_id: "o1",
            target_org_name: "Harbor",
            subject_table: "app.plan_overrides",
            subject_id: "po1",
            reason: "Pilot.",
            details: { kind: "Plan" },
            acted_at: "t",
          },
        ]),
      ],
    });
    const roster = await listOperators(db);
    expect(roster.ok && roster.data[0]?.role).toBe("Support");
    expect(
      await grantOperator(db, {
        email: " tess@platform.test ",
        role: "Trust and Safety",
        reason: "Moderation.",
      }),
    ).toEqual({ ok: true, data: "g2" });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({ p_email: "tess@platform.test" });
    expect(await revokeOperator(db, "g1", "Left.")).toEqual({ ok: true, data: "g1" });
    const log = await listActionLog(db, { orgId: "o1" });
    expect(log.ok && log.data[0]?.details).toEqual({ kind: "Plan" });
  });
});

describe("the org's side of platform support and moderation", () => {
  it("grants platform sessions, lists them and reads the access log", async () => {
    const { db, calls } = moduleClient({
      "rpc:grant_platform_support_session": [ok("s1")],
      "from:support_sessions": [
        ok([
          {
            id: "s1",
            reason: "Help.",
            starts_at: "2026-10-21T10:00:00Z",
            ends_at: "2026-10-21T14:00:00Z",
            ended_at: null,
          },
          {
            id: "s0",
            reason: "Old.",
            starts_at: "2026-10-01T10:00:00Z",
            ends_at: "2026-10-01T14:00:00Z",
            ended_at: null,
          },
        ]),
        denied,
      ],
      "rpc:support_session_access_log": [
        ok([
          {
            id: "x1",
            support_session_id: "s1",
            operator_name: "Omar Haddad",
            area: "Members",
            accessed_at: "t",
          },
        ]),
      ],
    });
    expect(
      await grantPlatformSupportSession(db, { orgId: "o1", hours: 4, reason: " Help. " }),
    ).toEqual({ ok: true, data: "s1" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_org_id: "o1",
      p_hours: 4,
      p_reason: "Help.",
    });
    const sessions = await listPlatformSupportSessions(db, "o1", new Date("2026-10-21T12:00:00Z"));
    expect(sessions.ok && sessions.data.map((s) => s.open)).toEqual([true, false]);
    expect(stepsOf(calls[1], "eq")).toContainEqual(["grantee", "Platform"]);
    expect((await listPlatformSupportSessions(db, "o1")).ok).toBe(false);
    const log = await listSupportAccessLog(db, "o1");
    expect(log.ok && log.data[0]).toMatchObject({ operatorName: "Omar Haddad", area: "Members" });
  });

  it("lists moderation decisions with their appeal and files an appeal", async () => {
    const { db } = moduleClient({
      "from:moderation_actions": [
        ok([
          {
            id: "d1",
            opportunity_id: "op1",
            action: "Removed",
            ground: "Terms Violation",
            rule_reference: "AUP 3.2",
            facts: "Fee.",
            statement_of_reasons: "Removed.",
            decided_at: "2026-10-20T00:00:00Z",
            opportunity: { title: "Riggers" },
            appeals: [],
          },
          {
            id: "d2",
            opportunity_id: "op2",
            action: "Restricted",
            ground: "Terms Violation",
            rule_reference: "AUP",
            facts: "F.",
            statement_of_reasons: "R.",
            decided_at: "2026-10-20T00:00:00Z",
            opportunity: null,
            appeals: [
              {
                id: "a1",
                appeal_state: "Open",
                filed_at: "t",
                decision_statement: null,
                deleted_at: null,
              },
            ],
          },
        ]),
        denied,
      ],
      "rpc:file_moderation_appeal": [ok("a2")],
    });
    const decisions = await listModerationDecisions(db, "o1");
    expect(decisions.ok).toBe(true);
    if (!decisions.ok) return;
    const now = new Date("2026-10-21T00:00:00Z");
    expect(decisions.data[0]?.opportunityTitle).toBe("Riggers");
    expect(decisions.data[1]?.appeal?.state).toBe("Open");
    const [first, second] = decisions.data;
    if (!first || !second) throw new Error("two decisions expected");
    expect(canAppeal(first, now)).toBe(true);
    expect(canAppeal(second, now)).toBe(false);
    expect(canAppeal(first, new Date("2027-05-01T00:00:00Z"))).toBe(false);
    expect(hasAppealable(decisions.data, now)).toBe(true);
    expect(appealDeadline("2026-10-20T00:00:00Z").toISOString()).toBe("2027-04-20T00:00:00.000Z");
    expect((await listModerationDecisions(db, "o1")).ok).toBe(false);
    expect(await fileModerationAppeal(db, { decisionId: "d1", grounds: " Legal fee. " })).toEqual({
      ok: true,
      data: "a2",
    });
  });
});

describe("system banners", () => {
  const banner = (over: Partial<SystemBanner> = {}): SystemBanner => ({
    id: "b1",
    kind: "Maintenance",
    severity: "Warning",
    message: "Maintenance tonight.",
    messageEs: "Mantenimiento esta noche.",
    linkUrl: null,
    startsAt: "2026-10-21T00:00:00Z",
    endsAt: "2026-10-22T00:00:00Z",
    dismissible: true,
    ...over,
  });

  it("parses rows and keeps only well-formed banners with https links", () => {
    expect(
      parseBanners([
        {
          id: "b1",
          banner_kind: "Incident",
          severity: "Critical",
          message: "Down.",
          message_es: "",
          link_url: "https://status.test",
          starts_at: "s",
          ends_at: null,
          dismissible: true,
        },
        {
          id: "b2",
          banner_kind: "Notice",
          severity: "Info",
          message: "Hi.",
          link_url: "javascript:alert(1)",
          starts_at: "s",
          dismissible: true,
        },
        { id: "b3", banner_kind: "Party", severity: "Info", message: "No.", starts_at: "s" },
        null,
      ]),
    ).toEqual([
      {
        id: "b1",
        kind: "Incident",
        severity: "Critical",
        message: "Down.",
        messageEs: null,
        linkUrl: "https://status.test",
        startsAt: "s",
        endsAt: null,
        dismissible: false,
      },
      {
        id: "b2",
        kind: "Notice",
        severity: "Info",
        message: "Hi.",
        messageEs: null,
        linkUrl: null,
        startsAt: "s",
        endsAt: null,
        dismissible: true,
      },
    ]);
    expect(parseBanners(null)).toEqual([]);
  });

  it("reads the live banners of a shell through api_public", async () => {
    const seen: unknown[] = [];
    const client = {
      schema: (name: string) => ({
        rpc: async (fn: string, args: unknown) => {
          seen.push([name, fn, args]);
          return seen.length === 1
            ? {
                data: [
                  {
                    id: "b1",
                    banner_kind: "Notice",
                    severity: "Info",
                    message: "Hi.",
                    starts_at: "s",
                    dismissible: true,
                  },
                ],
                error: null,
              }
            : { data: null, error: { code: "PGRST000", message: "down" } };
        },
      }),
    } as unknown as BannerClient;
    const result = await listActiveSystemBanners(client, "gateway");
    expect(result.ok && result.data.map((b) => b.id)).toEqual(["b1"]);
    expect(seen[0]).toEqual(["api_public", "active_system_banners", { p_surface: "gateway" }]);
    expect((await listActiveSystemBanners(client, "atlas")).ok).toBe(false);
  });

  it("picks the language, the tone and what to show", () => {
    expect(bannerText(banner(), "es-US")).toBe("Mantenimiento esta noche.");
    expect(bannerText(banner({ messageEs: null }), "es-US")).toBe("Maintenance tonight.");
    expect(bannerText(banner(), "en-US")).toBe("Maintenance tonight.");
    expect(bannerTone("Critical")).toBe("danger");
    expect(bannerTone("Warning")).toBe("warning");
    expect(bannerTone("Info")).toBe("info");
    const now = new Date("2026-10-21T12:00:00Z");
    const shown = visibleBanners(
      [
        banner({ id: "info", severity: "Info" }),
        banner({ id: "crit", severity: "Critical", dismissible: false }),
        banner({ id: "gone", endsAt: "2026-10-21T06:00:00Z" }),
        banner({ id: "later", startsAt: "2026-10-23T00:00:00Z", endsAt: null }),
        banner({ id: "hidden" }),
      ],
      ["hidden", "crit"],
      now,
    );
    expect(shown.map((b) => b.id)).toEqual(["crit", "info"]);
  });

  it("remembers dismissals on the device, bounded", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("not json")).toEqual([]);
    expect(parseDismissed('{"a":1}')).toEqual([]);
    expect(parseDismissed('["a", 2, "b"]')).toEqual(["a", "b"]);
    const many = Array.from({ length: 60 }, (_, i) => `b${i}`);
    expect(parseDismissed(JSON.stringify(many))).toHaveLength(50);
    expect(JSON.parse(addDismissed('["a","b"]', "a"))).toEqual(["b", "a"]);
  });

  it("caches each shell's answer and keeps the last one when a read fails", async () => {
    let now = 0;
    let reads = 0;
    const answers = [
      { ok: true as const, data: [banner()] },
      { ok: false as const, error: { kind: "unexpected" as const, message: "down" } },
    ];
    const cached = createBannerCache(
      async () => answers[reads++ % 2] ?? { ok: true as const, data: [] },
      60,
      () => now,
    );
    expect((await cached("atlas")).map((b) => b.id)).toEqual(["b1"]);
    expect((await cached("atlas")).map((b) => b.id)).toEqual(["b1"]);
    expect(reads).toBe(1);
    now = 61_000;
    const [a, b] = await Promise.all([cached("atlas"), cached("atlas")]);
    expect(reads).toBe(2);
    expect(a.map((x) => x.id)).toEqual(["b1"]);
    expect(b).toBe(a);
  });
});
