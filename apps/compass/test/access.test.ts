import { EXTERNAL_AUDIENCES, type Audience } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  access,
  certificationsUrl,
  documentsUrl,
  elsewhereLink,
  moreMenu,
  moreSections,
  operationalEngagements,
  scanModes,
  tabBar,
  todayBlocks,
  type CompassIdentity,
  type EngagementState,
  type Feature,
} from "../src/domain/access";

function internal(audience: "field" | "field-supervisor", capabilities: string[]): CompassIdentity {
  return {
    personId: "p",
    displayName: "Field User",
    audience,
    capabilities,
    membershipId: "m",
    engagements: [],
  };
}

function external(
  audience: Audience,
  state: EngagementState = "Active",
  projectId = "proj-1",
): CompassIdentity {
  return {
    personId: "x",
    displayName: "External User",
    audience,
    capabilities: [],
    membershipId: null,
    engagements: [
      {
        id: "e1",
        orgId: "o1",
        orgName: "Demo Org",
        projectId,
        projectName: "Demo",
        roleType: audience,
        state,
      },
    ],
  };
}

describe("internal access", () => {
  it("follows capabilities on the project", () => {
    const field = internal("field", ["crew.time_entry.write", "safety.incident.write"]);
    expect(access(field, "clock", "proj-1")).toEqual({ allowed: true });
    expect(access(field, "incidents.report", "proj-1")).toEqual({ allowed: true });
    expect(access(field, "inspections.perform", "proj-1")).toEqual({
      allowed: false,
      reason: "capability",
    });
    expect(access(field, "scan.credential.badge", "proj-1")).toEqual({ allowed: true });
  });

  it("keeps supervisor features to Field Supervisors", () => {
    const caps = ["crew.shift.read", "crew.timesheet.approve", "safety.incident.dispatch"];
    for (const f of ["crew.board", "timesheets.approve", "incidents.dispatch"] as Feature[]) {
      expect(access(internal("field", caps), f, "proj-1")).toEqual({
        allowed: false,
        reason: "role",
      });
      expect(access(internal("field-supervisor", caps), f, "proj-1")).toEqual({ allowed: true });
    }
  });
});

describe("external access (Section 8.7)", () => {
  it("lets crew, staff and contractors clock in through an active engagement", () => {
    for (const a of ["crew", "staff", "contractor"] as Audience[]) {
      expect(access(external(a), "clock", "proj-1")).toEqual({ allowed: true });
    }
    for (const a of [
      "client",
      "vendor",
      "artist",
      "artist-representative",
      "sponsor",
    ] as Audience[]) {
      expect(access(external(a), "clock", "proj-1")).toEqual({ allowed: false, reason: "role" });
    }
  });

  it("opens at Active, stays through Closing and ends at Complete", () => {
    expect(access(external("crew", "Onboarding"), "clock", "proj-1")).toEqual({
      allowed: false,
      reason: "engagement-not-active",
    });
    expect(access(external("crew", "Closing"), "clock", "proj-1")).toEqual({ allowed: true });
    expect(access(external("crew", "Complete"), "clock", "proj-1")).toEqual({
      allowed: false,
      reason: "engagement-closed",
    });
    expect(access(external("crew", "Canceled"), "clock", "proj-1")).toEqual({
      allowed: false,
      reason: "engagement-closed",
    });
  });

  it("does not carry an engagement on one project to another", () => {
    expect(access(external("crew", "Active", "proj-2"), "clock", "proj-1")).toEqual({
      allowed: false,
      reason: "engagement-not-active",
    });
    expect(access(external("crew", "Active", "proj-2"), "clock", null)).toEqual({ allowed: true });
  });

  it("never gives externals internal-only features", () => {
    const internalOnly: Feature[] = [
      "incidents.report",
      "incidents.dispatch",
      "inspections.perform",
      "show.live",
      "show.callCue",
      "scan.credential.validate",
      "scan.lookup",
      "kiosk.operate",
      "crew.board",
    ];
    for (const a of EXTERNAL_AUDIENCES) {
      for (const f of internalOnly)
        expect(access(external(a), f, "proj-1"), `${a} ${f}`).toEqual({
          allowed: false,
          reason: "role",
        });
    }
  });

  it("lists operational engagements only", () => {
    const id = external("crew");
    const closed = id.engagements.map((e) => ({ ...e, id: "e2", state: "Complete" as const }));
    expect(
      operationalEngagements({ ...id, engagements: [...id.engagements, ...closed] }, null).map(
        (e) => e.id,
      ),
    ).toEqual(["e1"]);
  });
});

describe("navigation from the sitemap", () => {
  it("gives everyone five tabs and supervisors a sixth", () => {
    expect(tabBar("crew").map((t) => t.id)).toEqual(["today", "schedule", "scan", "inbox", "more"]);
    expect(tabBar("field-supervisor").map((t) => t.id)).toEqual([
      "today",
      "schedule",
      "scan",
      "inbox",
      "more",
      "crew",
    ]);
  });

  it("orders the More menu with external additions first", () => {
    expect(moreMenu("field").map((m) => m.id)).toEqual([
      "incidents",
      "inspections",
      "logistics",
      "show",
      "expenses",
      "reference",
      "offline-queue",
      "profile",
      "settings",
    ]);
    expect(
      moreMenu("vendor")
        .map((m) => m.id)
        .slice(0, 3),
    ).toEqual(["purchase-orders", "deliveries", "submittals"]);
    const client = moreMenu("client");
    expect(client.find((m) => m.id === "run-of-show")?.readOnly).toBe(true);
  });

  it("renders every More entry as a Compass screen since A92 (A59-026 kept for any later entry)", () => {
    const crew = moreSections("crew");
    expect(crew.native.map((m) => m.id)).toEqual([
      "timesheets",
      "per-diem",
      "travel-and-lodging",
      "onboarding",
      "project-details",
      "offline-queue",
      "profile",
      "settings",
    ]);
    expect(moreSections("field").native.map((m) => m.id)).toContain("expenses");
    expect(moreSections("client").native.map((m) => m.id)).toContain("run-of-show");
    for (const audience of [
      "field",
      "field-supervisor",
      "client",
      "vendor",
      "contractor",
      "crew",
      "staff",
      "artist",
      "artist-representative",
      "sponsor",
    ] as const) {
      const { native, elsewhere } = moreSections(audience);
      expect(elsewhere, audience).toEqual([]);
      expect(native).toHaveLength(moreMenu(audience).length);
    }
    const urls = { atlasUrl: "https://atlas.test/", gatewayUrl: "https://gateway.test" };
    expect(elsewhereLink("crew", urls)).toEqual({
      app: "gateway",
      url: "https://gateway.test/work/engagements",
    });
    expect(elsewhereLink("field-supervisor", urls)).toEqual({
      app: "atlas",
      url: "https://atlas.test/",
    });
    expect(certificationsUrl("crew", urls)).toBe("https://gateway.test/profile");
    expect(certificationsUrl("field", urls)).toBe("https://atlas.test/");
    expect(documentsUrl("vendor", urls)).toBe("https://gateway.test/documents");
    expect(documentsUrl("field", urls)).toBe("https://atlas.test/");
  });

  it("reads scan modes and Today blocks per role", () => {
    expect(scanModes("crew")).toEqual([
      { mode: "credential", scope: "own" },
      { mode: "asset", scope: "assigned" },
    ]);
    expect(scanModes("client")).toEqual([]);
    expect(todayBlocks("vendor").map((b) => b.id)).toEqual([
      "dock-slot",
      "load-in-and-load-out-windows",
      "delivery-instructions",
    ]);
    expect(todayBlocks("artist")[1]).toEqual({
      id: "set-time",
      label: "nav.compass.content.setTime",
    });
  });
});
