import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_LENS_SCOPE,
  ROLE_ROUTED_KINDS,
  SYSTEM_ROLE_ROUTED_KINDS,
  inboxItemInLens,
  inboxItemRoute,
  inboxLens,
  personalCapabilities,
  lensCapabilities,
  lensOrgCapabilities,
  lesserReach,
  parseRoleLensCookie,
  roleLensCapabilities,
  roleLensCookie,
} from "../src/role-lens.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const ROLE = "01920000-0000-7000-8000-000000000a01";

describe("the role lens cookie", () => {
  it("round-trips a role id for its org and ignores other orgs", () => {
    const value = roleLensCookie("demo-productions", ROLE);
    expect(parseRoleLensCookie(value, "demo-productions")).toBe(ROLE);
    expect(parseRoleLensCookie(value, "other-org")).toBeNull();
    expect(parseRoleLensCookie(undefined, "demo-productions")).toBeNull();
    expect(parseRoleLensCookie("demo-productions:", "demo-productions")).toBeNull();
    expect(parseRoleLensCookie("demo-productions:not-a-role", "demo-productions")).toBeNull();
  });

  it("holds a Gateway role type under its own pattern", () => {
    const value = roleLensCookie(GATEWAY_LENS_SCOPE, "artist");
    expect(parseRoleLensCookie(value, GATEWAY_LENS_SCOPE, /^[a-z-]+$/)).toBe("artist");
    expect(parseRoleLensCookie(value, GATEWAY_LENS_SCOPE)).toBeNull();
  });
});

describe("lensCapabilities", () => {
  it("keeps only what the person holds", () => {
    const own = new Set(["work.record.read", "work.record.write", "finance.po.approve"]);
    expect([...lensCapabilities(own, ["work.record.read", "org.billing.manage"])]).toEqual([
      "work.record.read",
    ]);
  });

  it("is never wider than the person's own capabilities, whatever the role holds", () => {
    const universe = ["a", "b", "c", "d", "e", "f"];
    // Every pair of subsets of a six-capability universe.
    for (let ownMask = 0; ownMask < 64; ownMask += 1) {
      const own = new Set(universe.filter((_, i) => ownMask & (1 << i)));
      for (let roleMask = 0; roleMask < 64; roleMask += 1) {
        const role = universe.filter((_, i) => roleMask & (1 << i));
        const lensed = lensCapabilities(own, role);
        for (const capability of lensed) expect(own.has(capability)).toBe(true);
        expect(lensed.size).toBeLessThanOrEqual(own.size);
      }
    }
  });

  it("leaves nothing for a role that shares nothing with the person", () => {
    expect(lensCapabilities(new Set(["a"]), ["b"]).size).toBe(0);
    expect(lensCapabilities(new Set<string>(), ["a", "b"]).size).toBe(0);
  });
});

describe("lesserReach", () => {
  it("takes the narrower reach and drops a capability either side lacks", () => {
    expect(lesserReach("organization", "assigned")).toBe("assigned");
    expect(lesserReach("own", "organization")).toBe("own");
    expect(lesserReach("assigned", "assigned")).toBe("assigned");
    expect(lesserReach(null, "organization")).toBeNull();
    expect(lesserReach("organization", null)).toBeNull();
  });
});

describe("roleLensCapabilities", () => {
  it("calls app.role_lens_capabilities and maps each row", async () => {
    const { db, calls } = fakeClient({
      "rpc:role_lens_capabilities": [
        okResponse([
          {
            capability_code: "work.record.read",
            role_reach: "organization",
            viewer_reach: "organization",
            lens_reach: "organization",
          },
          {
            capability_code: "work.record.write",
            role_reach: "organization",
            viewer_reach: "assigned",
            lens_reach: "assigned",
          },
        ]),
      ],
    });
    const result = await roleLensCapabilities(db, "org-1", ROLE);
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "org-1", p_role_id: ROLE }]]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[1]).toEqual({
      capability: "work.record.write",
      roleReach: "organization",
      viewerReach: "assigned",
      lensReach: "assigned",
    });
    expect([...lensOrgCapabilities(result.data)]).toEqual(["work.record.read"]);
  });

  it("passes a refusal through", async () => {
    const { db } = fakeClient({
      "rpc:role_lens_capabilities": [
        errorResponse("XR001", "role_lens_role_not_held: Refused.", "role_lens_role_not_held"),
      ],
    });
    const result = await roleLensCapabilities(db, "org-1", ROLE);
    expect(result.ok).toBe(false);
  });
});

describe("the capabilities held through no role", () => {
  it("groups them by org", async () => {
    const { db } = fakeClient({
      "rpc:role_lens_personal_capabilities": [
        okResponse([
          { org_id: "org-1", capability_code: "crew.timesheet.approve" },
          { org_id: "org-1", capability_code: "finance.po.approve" },
          { org_id: "org-2", capability_code: "safety.incident.dispatch" },
        ]),
      ],
    });
    const result = await personalCapabilities(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...(result.data.get("org-1") ?? [])]).toEqual([
      "crew.timesheet.approve",
      "finance.po.approve",
    ]);
    expect([...(result.data.get("org-2") ?? [])]).toEqual(["safety.incident.dispatch"]);
  });
});

describe("the Inbox under a lens", () => {
  const MANAGER = { id: "role-manager", code: "manager", system: true };
  const MEMBER = { id: "role-member", code: "member", system: true };
  const OWNER = { id: "role-owner", code: "owner", system: true };
  // A custom role an org named "owner": only the platform Owner role is sent the Owner's notices.
  const CUSTOM = { id: "role-custom", code: "owner", system: false };
  const held = [MANAGER.id, MEMBER.id, OWNER.id, CUSTOM.id];
  const lens = (
    role: { id: string; code: string; system: boolean },
    roleCapabilities: string[],
    personal: string[] = [],
  ) => inboxLens({ role, heldRoleIds: held, roleCapabilities, personalCapabilities: personal });
  const manager = lens(MANAGER, [
    "finance.po.approve",
    "crew.timesheet.approve",
    "work.record.read",
  ]);
  const member = lens(MEMBER, ["work.record.read"]);

  it("shows everything under All roles", () => {
    for (const kind of [
      ...Object.keys(ROLE_ROUTED_KINDS),
      ...Object.keys(SYSTEM_ROLE_ROUTED_KINDS),
    ]) {
      expect(inboxItemInLens({ kind, subjectTable: null }, null)).toBe(true);
    }
  });

  it("keeps what is addressed to the person under every lens", () => {
    for (const kind of [
      "mention.created",
      "assignment.created",
      "shift.assigned",
      "message.received",
    ]) {
      expect(inboxItemInLens({ kind, subjectTable: "records" }, member)).toBe(true);
      expect(inboxItemRoute({ kind, subjectTable: "records" })).toEqual({ by: "person" });
    }
  });

  it("keeps a spend approval request under the role its step names, and only that role", () => {
    const managerStep = {
      kind: "approval.requested",
      subjectTable: "approval_instances",
      approverRoleId: MANAGER.id,
    };
    expect(inboxItemRoute(managerStep)).toEqual({ by: "role", roleId: MANAGER.id });
    expect(inboxItemInLens(managerStep, manager)).toBe(true);
    expect(inboxItemInLens(managerStep, member)).toBe(false);
    // The role brought it even when the role lacks the approval capability the decision also needs.
    const memberStep = { ...managerStep, approverRoleId: MEMBER.id };
    expect(inboxItemInLens(memberStep, member)).toBe(true);
    expect(inboxItemInLens(memberStep, manager)).toBe(false);
  });

  it("keeps a request addressed to the person, by a named member or as a delegate, under every lens", () => {
    const named = {
      kind: "approval.requested",
      subjectTable: "app.approval_instances",
      approverRoleId: null,
    };
    expect(inboxItemRoute(named)).toEqual({ by: "person" });
    expect(inboxItemInLens(named, member)).toBe(true);
    expect(inboxItemInLens(named, manager)).toBe(true);
    // A step naming a role the person does not hold reached them as an away approver's delegate.
    const delegated = { ...named, approverRoleId: "role-elsewhere" };
    expect(inboxItemInLens(delegated, member)).toBe(true);
    expect(inboxItemInLens(delegated, manager)).toBe(true);
  });

  it("routes a timesheet request by the capability its sender picks", () => {
    const sheet = { kind: "approval.requested", subjectTable: "timesheets" };
    expect(inboxItemInLens(sheet, manager)).toBe(true);
    expect(inboxItemInLens(sheet, member)).toBe(false);
    // An approver by a direct grant or a delegation keeps it under every lens.
    expect(
      inboxItemInLens(sheet, lens(MEMBER, ["work.record.read"], ["crew.timesheet.approve"])),
    ).toBe(true);
  });

  it("hides a capability-picked notice from a role without its capability", () => {
    const incident = { kind: "incident.reported", subjectTable: "app.incidents" };
    expect(inboxItemInLens(incident, member)).toBe(false);
    expect(inboxItemInLens(incident, lens(MEMBER, ["safety.incident.dispatch"]))).toBe(true);
  });

  it("keeps the Owner's and break-glass notices for the platform roles they are sent to", () => {
    const deletion = {
      kind: "organization.deletion_requested",
      subjectTable: "app.org_deletion_requests",
    };
    const breakGlass = { kind: "access.break_glass_started", subjectTable: "break_glass_sessions" };
    const owner = lens(OWNER, ["org.organization.delete", "org.security.write"]);
    const custom = lens(CUSTOM, ["org.organization.delete", "org.security.write"]);
    const admin = lens({ id: "role-admin", code: "admin", system: true }, ["org.security.write"]);
    expect(inboxItemInLens(deletion, owner)).toBe(true);
    expect(inboxItemInLens(deletion, custom)).toBe(false);
    expect(inboxItemInLens(deletion, admin)).toBe(false);
    expect(inboxItemInLens(breakGlass, owner)).toBe(true);
    expect(inboxItemInLens(breakGlass, admin)).toBe(true);
    expect(inboxItemInLens(breakGlass, custom)).toBe(false);
    expect(inboxItemInLens(breakGlass, manager)).toBe(false);
  });
});

// Each routed kind against the latest migration that sends it: what the sender picks recipients by is what the lens
// keeps the notice for, so a role shows exactly the notices it brought.
describe("the routed kinds follow their senders", () => {
  const dir = new URL("../../../supabase/migrations/", import.meta.url);
  // Every migration's text, in file order.
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8"));
  const escape = (text: string) => text.replaceAll(".", "\\.");
  const notifyOf = (kind: string, subject?: string) =>
    new RegExp(`notify\\([^;]*?'${escape(kind)}'${subject ? `, '${escape(subject)}'` : ""}`);
  const capabilityPick =
    /(?:project_member_people_with\([^,]+,|person_capability_reach\([^,]+,[^,]+,)\s*'([a-z_]+\.[a-z_]+\.[a-z_]+)'/g;

  /** The latest definition of a function, from its create to the end of its body. */
  function latestBody(name: string): string {
    const head = `create or replace function ${name}(`;
    const body = migrations.filter((m) => m.includes(head)).at(-1) ?? "";
    expect(body, name).not.toBe("");
    const at = body.indexOf(head);
    return body.slice(at, body.indexOf("$$;", at));
  }
  const helperBody = (name: string) => latestBody(`private.${name}`);

  /** The recipient query of a kind's latest sender: from the loop that picks people to the notify call. */
  function recipients(kind: string, subject?: string): string {
    const body = migrations.filter((m) => notifyOf(kind, subject).test(m)).at(-1) ?? "";
    expect(body, kind).not.toBe("");
    const at = body.search(notifyOf(kind, subject));
    return body.slice(body.lastIndexOf("for v_", at), at);
  }

  function pickedCapabilities(kind: string, subject?: string): string[] {
    const query = recipients(kind, subject);
    const helpers = [...query.matchAll(/private\.(\w+_ids)\(/g)].map((m) => helperBody(m[1] ?? ""));
    const picked = [query, ...helpers].flatMap((s) =>
      [...s.matchAll(capabilityPick)].map((m) => m[1] ?? ""),
    );
    return [...new Set(picked)].sort();
  }

  const byCapability = [
    "incident.reported",
    "occupancy.threshold",
    "content_report.filed",
    "content_report.overdue",
    "billing.payment_failed",
    "billing.read_only",
    "billing.trial_ending",
    "billing.trial_ended",
    "partner.client_left",
  ];
  const byOwnerRole = [
    "organization.deletion_requested",
    "organization.deletion_recovered",
    "organization.white_label_reverting",
    "organization.white_label_reverted",
  ];

  it("keeps each capability-picked notice for the capability its sender picks by", () => {
    for (const kind of byCapability) {
      expect([...(ROLE_ROUTED_KINDS[kind] ?? [])].sort(), kind).toEqual(pickedCapabilities(kind));
    }
    expect(Object.keys(ROLE_ROUTED_KINDS).sort()).toEqual([...byCapability].sort());
  });

  it("routes the trial notices like the other billing notices, by org.billing.read", () => {
    expect(pickedCapabilities("billing.trial_ending")).toEqual(["org.billing.read"]);
    const billingOnly = inboxLens({
      role: { id: "r1", code: "billing", system: false },
      heldRoleIds: ["r1", "r2"],
      roleCapabilities: ["org.billing.read"],
      personalCapabilities: [],
    });
    const deleteOnly = inboxLens({
      role: { id: "r2", code: "closer", system: false },
      heldRoleIds: ["r1", "r2"],
      roleCapabilities: ["org.organization.delete"],
      personalCapabilities: [],
    });
    for (const kind of ["billing.trial_ending", "billing.trial_ended"]) {
      expect(inboxItemInLens({ kind, subjectTable: "app.subscriptions" }, billingOnly)).toBe(true);
      expect(inboxItemInLens({ kind, subjectTable: "app.subscriptions" }, deleteOnly)).toBe(false);
    }
  });

  it("keeps the Owner's notices for the platform Owner role and break-glass notices for Owner and Admin", () => {
    expect(helperBody("org_owner_ids")).toContain("private.system_role_id('owner')");
    for (const kind of byOwnerRole) {
      expect(recipients(kind), kind).toContain("private.org_owner_ids(");
      expect(SYSTEM_ROLE_ROUTED_KINDS[kind], kind).toEqual(["owner"]);
    }
    expect(recipients("access.break_glass_started")).toContain(
      "r.org_id is null and r.code in ('owner', 'admin')",
    );
    expect(SYSTEM_ROLE_ROUTED_KINDS["access.break_glass_started"]).toEqual(["owner", "admin"]);
    expect(Object.keys(SYSTEM_ROLE_ROUTED_KINDS).sort()).toEqual(
      [...byOwnerRole, "access.break_glass_started"].sort(),
    );
  });

  it("keeps a spend approval request for the role or the member its step names, as its sender picks", () => {
    // private.notify_step_approvers asks the people private.step_approver_person_ids lists for the current step.
    expect(recipients("approval.requested", "approval_instances")).toContain(
      "private.step_approver_person_ids(p_instance.approval_policy_id, p_instance.current_step",
    );
    const picks = helperBody("step_approver_person_ids");
    expect(picks).toContain("m.id = s.approver_membership_id");
    expect(picks).toContain("mr.role_id = s.approver_role_id");
    // An away approver's delegate is asked in their place: a step naming a role the delegate does not hold.
    expect(picks).toContain("private.away_delegate_person_ids(");
    expect([...picks.matchAll(capabilityPick)]).toEqual([]);
    // The Inbox names the role of the step the approval waits on.
    const inbox =
      migrations.filter((m) => m.includes("create or replace view app.inbox_items")).at(-1) ?? "";
    expect(inbox).toContain("st.approver_role_id");
    expect(inbox).toContain("st.step_order = a.current_step");
  });

  it("routes a timesheet request by crew.timesheet.approve, as its sender picks", () => {
    expect(pickedCapabilities("approval.requested", "timesheets")).toEqual([
      "crew.timesheet.approve",
    ]);
    expect(inboxItemRoute({ kind: "approval.requested", subjectTable: "timesheets" })).toEqual({
      by: "capability",
      capabilities: ["crew.timesheet.approve"],
    });
  });

  it("shows a weather alert under every lens, since project roles a weather plan names receive it too", () => {
    expect(recipients("weather.alert")).toContain("app.weather_alert_roles");
    expect(inboxItemRoute({ kind: "weather.alert", subjectTable: "app.weather_alerts" })).toEqual({
      by: "person",
    });
  });
});
