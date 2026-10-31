import { describe, expect, it } from "vitest";
import type { Role, XosClient } from "@xos/data";
import { inboxItemInLens, roleLensCookie } from "@xos/data/role-lens";
import type { Membership } from "../lib/shell/membership";
import { applyRoleLens } from "../lib/shell/role-lens";

// The role lens of the org switcher (A128, ADR 0107): the lensed context is never wider than the person's own.

const MANAGER: Role = {
  id: "01920000-0000-7000-8000-00000000a001",
  code: "manager",
  name: null,
  band: 3,
  system: true,
};
const MEMBER: Role = {
  id: "01920000-0000-7000-8000-00000000a002",
  code: "member",
  name: null,
  band: 4,
  system: true,
};
const OTHER: Role = {
  id: "01920000-0000-7000-8000-00000000a003",
  code: "owner",
  name: null,
  band: 1,
  system: true,
};

const OWN = new Set([
  "work.record.read",
  "work.record.write",
  "crew.timesheet.approve",
  "finance.po.approve",
]);

function membership(roles: readonly Role[]): Membership {
  return {
    org: {
      id: "01920000-0000-7000-8000-000000000001",
      slug: "demo",
      name: "Demo",
      membershipId: "01920000-0000-7000-8000-000000000901",
      roles,
      bestBand: Math.min(...roles.map((r) => r.band)),
    },
    role: "manager",
    capabilities: OWN,
    nav: { role: "manager", conditions: ["desktop"] },
    persona: null,
  } as unknown as Membership;
}

type Row = {
  capability_code: string;
  role_reach: string;
  viewer_reach: string;
  lens_reach: string;
};

/**
 * A client whose app.role_lens_capabilities answers with `rows`, or refuses, and whose
 * app.role_lens_personal_capabilities answers with `personal` (org id and capability).
 */
function client(
  rows: Row[] | "refused",
  personal: { org_id: string; capability_code: string }[] = [],
): XosClient {
  return {
    rpc: async (fn: string) =>
      fn === "role_lens_personal_capabilities"
        ? { data: personal, error: null }
        : rows === "refused"
          ? {
              data: null,
              error: {
                code: "XR001",
                message:
                  "role_lens_role_not_held: Choose one of the roles you hold in this organization.",
                hint: null,
              },
            }
          : { data: rows, error: null },
  } as unknown as XosClient;
}

const row = (capability: string, reach = "organization"): Row => ({
  capability_code: capability,
  role_reach: reach,
  viewer_reach: reach,
  lens_reach: reach,
});

describe("applyRoleLens", () => {
  it("shows All roles without a lens cookie", async () => {
    const lensed = await applyRoleLens(client([]), membership([MANAGER, MEMBER]), undefined);
    expect(lensed.lens.role).toBeNull();
    expect(lensed.lens.inbox).toBeNull();
    expect(lensed.capabilities).toBe(OWN);
  });

  it("narrows to the role and never past the person's own capabilities", async () => {
    // Even if the database answered with a capability the person lacks, the lens drops it.
    const db = client([
      row("work.record.read"),
      row("work.record.write", "assigned"),
      row("org.billing.manage"),
    ]);
    const lensed = await applyRoleLens(
      db,
      membership([MANAGER, MEMBER]),
      roleLensCookie("demo", MEMBER.id),
    );
    expect(lensed.lens.role).toEqual(MEMBER);
    expect([...lensed.capabilities]).toEqual(["work.record.read"]);
    for (const capability of lensed.capabilities) expect(OWN.has(capability)).toBe(true);
    expect(lensed.org.roles).toEqual([MEMBER]);
    expect(lensed.role).toBe("member");
    expect(lensed.nav.role).toBe("member");
    // Navigation for every role the person holds stays for the route guard.
    expect(lensed.lens.ownNav.role).toBe("manager");
  });

  it("keeps in the Inbox what the lens role brought and what is addressed to the person", async () => {
    const org = "01920000-0000-7000-8000-000000000001";
    const db = client(
      [row("work.record.read")],
      [
        { org_id: org, capability_code: "crew.timesheet.approve" },
        {
          org_id: "01920000-0000-7000-8000-000000000002",
          capability_code: "safety.incident.dispatch",
        },
      ],
    );
    const lensed = await applyRoleLens(
      db,
      membership([MANAGER, MEMBER]),
      roleLensCookie("demo", MEMBER.id),
    );
    const inbox = lensed.lens.inbox;
    expect(inbox?.roleId).toBe(MEMBER.id);
    expect(inbox?.systemRoleCode).toBe("member");
    expect([...(inbox?.heldRoleIds ?? [])]).toEqual([MANAGER.id, MEMBER.id]);
    const step = (roleId: string) => ({
      kind: "approval.requested",
      subjectTable: "approval_instances",
      approverRoleId: roleId,
    });
    expect(inboxItemInLens(step(MEMBER.id), inbox ?? null)).toBe(true);
    expect(inboxItemInLens(step(MANAGER.id), inbox ?? null)).toBe(false);
    // A timesheet approver by a direct grant keeps the requests under every lens; another org's grant does not count.
    expect(
      inboxItemInLens({ kind: "approval.requested", subjectTable: "timesheets" }, inbox ?? null),
    ).toBe(true);
    expect(
      inboxItemInLens({ kind: "incident.reported", subjectTable: "incidents" }, inbox ?? null),
    ).toBe(false);
  });

  it("keeps the role's band no better than the best band the person holds", async () => {
    const db = client([row("work.record.read")]);
    const lensed = await applyRoleLens(
      db,
      membership([MANAGER, MEMBER]),
      roleLensCookie("demo", MANAGER.id),
    );
    expect(lensed.org.bestBand).toBe(MANAGER.band);
  });

  it("ignores a role the person does not hold, a cookie for another org and a person with one role", async () => {
    const db = client([row("work.record.read")]);
    expect(
      (await applyRoleLens(db, membership([MANAGER, MEMBER]), roleLensCookie("demo", OTHER.id)))
        .lens.role,
    ).toBeNull();
    expect(
      (await applyRoleLens(db, membership([MANAGER, MEMBER]), roleLensCookie("other", MEMBER.id)))
        .lens.role,
    ).toBeNull();
    expect(
      (await applyRoleLens(db, membership([MEMBER]), roleLensCookie("demo", MEMBER.id))).lens.role,
    ).toBeNull();
  });

  it("falls back to All roles when the database refuses the role", async () => {
    const lensed = await applyRoleLens(
      client("refused"),
      membership([MANAGER, MEMBER]),
      roleLensCookie("demo", MEMBER.id),
    );
    expect(lensed.lens.role).toBeNull();
    expect(lensed.capabilities).toBe(OWN);
  });
});
