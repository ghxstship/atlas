import { describe, expect, it } from "vitest";
import { inboxItemInLens } from "@xos/data/role-lens";
import { internalAudience } from "../src/data/identity";
import type { CompassIdentity, EngagementSummary } from "../src/domain/access";
import {
  activeLens,
  lensIdentity,
  lensInbox,
  lensOptions,
  type LensContext,
} from "../src/domain/roleLens";

const base: CompassIdentity = {
  personId: "p1",
  displayName: "Demo Multi-Role",
  audience: "field-supervisor",
  // Member and Field roles, plus a project role's dispatch.
  capabilities: [
    "crew.shift.read",
    "crew.time_entry.write",
    "safety.incident.dispatch",
    "work.record.write",
  ],
  membershipId: "m1",
  engagements: [],
};

const member: LensContext = {
  kind: "member",
  identity: base,
  roles: [
    {
      id: "r-member",
      code: "member",
      name: null,
      system: true,
      capabilities: ["crew.shift.read", "work.record.write"],
    },
    {
      id: "r-field",
      code: "field",
      name: null,
      system: true,
      // A capability the person does not hold on this device never appears under the lens.
      capabilities: ["crew.shift.read", "crew.time_entry.write", "org.billing.manage"],
    },
  ],
};

const engagement = (id: string, roleType: EngagementSummary["roleType"]): EngagementSummary => ({
  id,
  orgId: "o1",
  orgName: "Demo Harbor Events",
  projectId: `prj-${id}`,
  projectName: "Harbor Fall Regatta",
  roleType,
  state: "Active",
});

const engaged: LensContext = {
  kind: "engaged",
  identity: {
    ...base,
    audience: "crew",
    capabilities: [],
    membershipId: null,
    engagements: [engagement("e1", "crew"), engagement("e2", "artist"), engagement("e3", "crew")],
  },
};

describe("lensOptions", () => {
  it("offers a member's org roles and an engaged person's role types", () => {
    expect(lensOptions(member).map((o) => o.id)).toEqual(["r-member", "r-field"]);
    expect(lensOptions(engaged).map((o) => [o.id, o.kind])).toEqual([
      ["artist", "role-type"],
      ["crew", "role-type"],
    ]);
  });

  it("offers nothing to a person with one role", () => {
    expect(lensOptions({ ...member, roles: member.roles?.slice(0, 1) ?? [] })).toEqual([]);
    expect(lensOptions({ kind: "member", identity: base })).toEqual([]);
  });
});

describe("lensIdentity", () => {
  it("returns the identity unchanged under All roles", () => {
    expect(lensIdentity(member, null, internalAudience)).toBe(base);
    expect(lensIdentity(member, "not-a-role", internalAudience)).toBe(base);
    expect(activeLens(member, "not-a-role")).toBeNull();
  });

  it("narrows a member to the role's capabilities they hold, never wider", () => {
    const field = lensIdentity(member, "r-field", internalAudience);
    expect(field.capabilities).toEqual(["crew.shift.read", "crew.time_entry.write"]);
    expect(field.capabilities).not.toContain("org.billing.manage");
    // The project role's dispatch belongs to no org role, so the lens drops it and the supervisor mode with it.
    expect(field.audience).toBe("field");
    for (const option of lensOptions(member)) {
      const lensed = lensIdentity(member, option.id, internalAudience);
      for (const c of lensed.capabilities) expect(base.capabilities).toContain(c);
    }
  });

  it("narrows an engaged person to one role type's engagements", () => {
    const artist = lensIdentity(engaged, "artist", internalAudience);
    expect(artist.engagements.map((e) => e.id)).toEqual(["e2"]);
    expect(artist.audience).toBe("artist");
  });
});

describe("lensInbox", () => {
  it("narrows a member's Inbox to the lens and leaves All roles and engaged people alone", () => {
    const field = lensIdentity(member, "r-field", internalAudience);
    const inbox = lensInbox(member, "r-field", field);
    expect([...(inbox?.capabilities ?? [])].sort()).toEqual(field.capabilities);
    expect(inbox?.roleId).toBe("r-field");
    expect(inbox?.systemRoleCode).toBe("field");
    expect(lensInbox(member, null, base)).toBeNull();
    expect(lensInbox(engaged, "artist", engaged.identity)).toBeNull();
  });

  it("keeps an approval step under the role it names, and a notice picked by a grant under every lens", () => {
    const granted: LensContext = { ...member, personalCapabilities: ["safety.incident.dispatch"] };
    const field = lensIdentity(granted, "r-field", internalAudience);
    const inbox = lensInbox(granted, "r-field", field);
    const step = (roleId: string) => ({
      kind: "approval.requested",
      subjectTable: "approval_instances",
      approverRoleId: roleId,
    });
    expect(inboxItemInLens(step("r-field"), inbox)).toBe(true);
    expect(inboxItemInLens(step("r-member"), inbox)).toBe(false);
    // A step naming a role the person does not hold reached them as a delegate, so it is theirs under every lens.
    expect(inboxItemInLens(step("r-elsewhere"), inbox)).toBe(true);
    expect(inboxItemInLens({ kind: "incident.reported", subjectTable: "incidents" }, inbox)).toBe(
      true,
    );
    const member2 = lensInbox(
      granted,
      "r-member",
      lensIdentity(granted, "r-member", internalAudience),
    );
    expect(inboxItemInLens(step("r-field"), member2)).toBe(false);
  });
});
