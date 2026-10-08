import { describe, expect, it } from "vitest";
import {
  chromeSlot,
  COMPASS_AUDIENCES,
  guardRoute,
  indexSitemap,
  MAX_DEPTH,
  navigationTree,
  validateSitemap,
  type CompassAudience,
} from "../src/index.ts";
import { childIds, labelOf, loadApp, messages } from "./support.ts";

const compass = loadApp("compass");
const label = (id: string) => labelOf(indexSitemap(compass).byId.get(id)?.node.label ?? "");
const BASE_MORE = [
  "Incidents",
  "Inspections",
  "Logistics",
  "Show",
  "Expenses",
  "Reference",
  "Offline Queue",
  "Profile and Certifications",
  "Settings",
];

function moreMenu(role: CompassAudience): string[] {
  const tabs = navigationTree(compass, { role }, ["tab-bar"])[0]?.children ?? [];
  return (tabs.find((t) => t.id === "more")?.children ?? []).map((c) => labelOf(c.label));
}

function tabBar(role: CompassAudience): string[] {
  return chromeSlot(compass, "tabBar", { role }).map((n) => labelOf(n.label));
}

describe("compass sitemap", () => {
  it("passes every validator", () => {
    expect(validateSitemap(compass, { messages })).toEqual([]);
  });

  it("keeps every node within 3 steps of Today", () => {
    expect(Math.max(...indexSitemap(compass).order.map((e) => e.depth))).toBeLessThanOrEqual(
      MAX_DEPTH,
    );
  });

  it("shows the same five tabs to everyone and Crew only to supervisors", () => {
    const five = ["Today", "Schedule", "Scan", "Inbox", "More"];
    for (const role of COMPASS_AUDIENCES) {
      expect(tabBar(role), role).toEqual(role === "field-supervisor" ? [...five, "Crew"] : five);
    }
    expect(childIds(compass, "crew").map(label)).toEqual([
      "Crew Board",
      "Timesheet Approvals",
      "Dispatch Board",
      "Shift Coverage",
    ]);
    expect(guardRoute(compass, "/crew/board", { role: "field" }).status).toBe(404);
  });

  it("lists the More menu in the 4.5.7 order for internal field users", () => {
    expect(moreMenu("field")).toEqual(BASE_MORE);
    expect(moreMenu("field-supervisor")).toEqual(BASE_MORE);
    expect(childIds(compass, "reference").map(label)).toEqual([
      "Emergency Codes",
      "Radio Channels",
      "Venue Maps",
      "SOPs",
    ]);
  });

  it.each<[CompassAudience, string[]]>([
    ["crew", ["Timesheets", "Per Diem", "Travel and Lodging", "Onboarding Items"]],
    ["staff", ["Timesheets", "Per Diem", "Travel and Lodging", "Onboarding Items"]],
    ["vendor", ["Purchase Orders", "Deliveries", "Submittals"]],
    ["contractor", ["Time Entries", "Deliverables"]],
    ["artist", ["Advance Summary", "Rider", "Settlement"]],
    ["artist-representative", ["Advance Summary", "Rider", "Settlement"]],
    ["client", ["Run of Show", "Reports"]],
    ["sponsor", ["Proof of Performance"]],
  ])("adds the role items to the More menu for %s", (role, adds) => {
    expect(moreMenu(role)).toEqual([
      ...adds,
      "Offline Queue",
      "Profile and Certifications",
      "Settings",
    ]);
  });

  it("offers the scan modes each audience may use", () => {
    const modes = (role: CompassAudience) =>
      (navigationTree(compass, { role }, ["tab-bar"])[0]?.children ?? [])
        .find((t) => t.id === "scan")
        ?.children.map((c) => labelOf(c.label));
    expect(modes("field")).toEqual(["Asset", "Receiving", "Credential", "Lookup"]);
    expect(modes("crew")).toEqual(["Asset", "Credential"]);
    expect(modes("vendor")).toEqual(["Receiving", "Credential"]);
    expect(modes("artist")).toEqual(["Credential"]);
    expect(modes("client")).toEqual([]);
    expect(compass.contentProfiles?.["crew"]?.scanModes).toEqual([
      { mode: "credential", scope: "own" },
      { mode: "asset", scope: "assigned" },
    ]);
  });

  it("shows role-aware Today content", () => {
    const today = (role: CompassAudience) =>
      compass.contentProfiles?.[role]?.today.map((id) => {
        const block = compass.contentBlocks?.find((b) => b.id === id);
        return labelOf(block?.label ?? "");
      });
    expect(today("field")).toEqual(["Shifts", "Tasks", "Day Sheet", "Run of Show"]);
    expect(today("vendor")).toEqual([
      "Dock Slot",
      "Load-In and Load-Out Windows",
      "Delivery Instructions",
    ]);
    expect(today("client")).toEqual(["Show-Day Schedule", "Approvals Waiting"]);
  });

  it("opens compass://r/{recordKey} on the record screen", () => {
    expect(compass.deepLinks).toEqual([{ pattern: "compass://r/{recordKey}", node: "record" }]);
    expect(guardRoute(compass, "/r/NWL-142", { role: "crew" })).toMatchObject({
      status: 200,
      id: "record",
    });
  });

  it("leaves Keyboard Shortcuts out of Compass settings", () => {
    const sections = childIds(compass, "settings");
    expect(sections).toHaveLength(14);
    expect(sections).not.toContain("settings.keyboard-shortcuts");
  });
});
