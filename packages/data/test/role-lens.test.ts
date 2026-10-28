import { describe, expect, it } from "vitest";
import {
  GATEWAY_LENS_SCOPE,
  ROLE_ROUTED_KINDS,
  SPEND_APPROVE_CAPABILITY,
  inboxItemCapabilities,
  inboxItemInLens,
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
    expect(lensCapabilities(new Set(), ["a", "b"]).size).toBe(0);
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

describe("the Inbox under a lens", () => {
  const manager = new Set(["finance.po.approve", "crew.timesheet.approve", "work.record.read"]);
  const member = new Set(["work.record.read"]);

  it("shows everything under All roles", () => {
    for (const kind of Object.keys(ROLE_ROUTED_KINDS)) {
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
      expect(inboxItemCapabilities({ kind, subjectTable: "records" })).toBeNull();
    }
  });

  it("routes an approval request by the capability its document type is approved with", () => {
    const po = {
      kind: "approval.requested",
      subjectTable: "approval_instances",
      documentType: "Purchase Order",
    };
    expect(inboxItemCapabilities(po)).toEqual(["finance.po.approve"]);
    expect(inboxItemInLens(po, manager)).toBe(true);
    expect(inboxItemInLens(po, member)).toBe(false);
    const sheet = { kind: "approval.requested", subjectTable: "timesheets" };
    expect(inboxItemInLens(sheet, manager)).toBe(true);
    expect(inboxItemInLens(sheet, member)).toBe(false);
  });

  it("keeps an approval request of unknown document type for any spend approver", () => {
    const unknown = { kind: "approval.requested", subjectTable: "app.approval_instances" };
    expect(inboxItemCapabilities(unknown)).toEqual(Object.values(SPEND_APPROVE_CAPABILITY));
    expect(inboxItemInLens(unknown, manager)).toBe(true);
    expect(inboxItemInLens(unknown, member)).toBe(false);
  });

  it("hides a role-routed notice from a role without its capability", () => {
    const incident = { kind: "incident.reported", subjectTable: "app.incidents" };
    expect(inboxItemInLens(incident, member)).toBe(false);
    expect(inboxItemInLens(incident, new Set(["safety.incident.dispatch"]))).toBe(true);
  });
});
