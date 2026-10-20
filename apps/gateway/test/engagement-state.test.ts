import { getMessages, locales } from "@xos/i18n";
import { engagementTabIds, isNodeVisible } from "@xos/ia";
import { loadSitemapFile } from "@xos/ia/node";
import { describe, expect, it } from "vitest";
import { closedArea, doesPaidWork, isLiveEngagement, overviewRows } from "../lib/engagement-state";
import { navContext, routeNeeds } from "../lib/shell/standing";

/**
 * What an engagement's state and role type mean for Gateway (findings A59-021 and A59-033): the
 * closed-section copy follows the state, the Overview rows follow the role type, and payout, tax
 * and work details are hidden from people the org never pays.
 */
const sitemap = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));
const tabs = (roleType: Parameters<typeof engagementTabIds>[1]) =>
  engagementTabIds(sitemap, roleType);

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }, messages);
}

describe("closed sections follow the engagement state (A59-021)", () => {
  it("never tells a Complete engagement to finish onboarding", () => {
    for (const roleType of ["vendor", "crew", "client", "artist", "sponsor"] as const) {
      const closed = closedArea("Complete", tabs(roleType));
      expect(closed.sentence).toBe("gateway.engagement.closed.complete");
      expect(closed.action).not.toBe("gateway.engagement.onboardingAction");
    }
  });

  it("links a Complete vendor engagement to its invoices, which stay open", () => {
    expect(closedArea("Complete", tabs("vendor"))).toEqual({
      sentence: "gateway.engagement.closed.complete",
      action: "gateway.engagement.invoicesAction",
      tab: "engagement.invoices",
    });
    expect(closedArea("Complete", tabs("artist")).tab).toBe("engagement.documents");
  });

  it("sends a Canceled engagement to its documents", () => {
    expect(closedArea("Canceled", tabs("crew"))).toMatchObject({
      sentence: "gateway.engagement.closed.canceled",
      tab: "engagement.documents",
    });
  });

  it("before Active, opens Onboarding where the role type has it, else Messages", () => {
    expect(closedArea("Onboarding", tabs("crew"))).toEqual({
      sentence: "gateway.engagement.closed.beforeActive",
      action: "gateway.engagement.onboardingAction",
      tab: "engagement.onboarding",
    });
    expect(closedArea("Blocked", tabs("vendor"))).toMatchObject({
      sentence: "gateway.engagement.closed.beforeActiveOrg",
      tab: "engagement.messages",
    });
  });

  it("points every action at a tab in the viewer's set, and every key has copy", () => {
    for (const locale of locales) {
      const messages = getMessages(locale) as Record<string, unknown>;
      for (const roleType of [
        "client",
        "vendor",
        "contractor",
        "crew",
        "staff",
        "artist",
        "sponsor",
      ] as const) {
        for (const state of [
          "Onboarding",
          "Blocked",
          "Active",
          "Closing",
          "Complete",
          "Canceled",
        ] as const) {
          const closed = closedArea(state, tabs(roleType));
          expect(tabs(roleType)).toContain(closed.tab);
          expect(typeof lookup(messages, closed.sentence)).toBe("string");
          expect(typeof lookup(messages, closed.action)).toBe("string");
        }
      }
    }
  });

  it("offers operational actions only while the engagement is live", () => {
    expect(isLiveEngagement("Active")).toBe(true);
    expect(isLiveEngagement("Closing")).toBe(true);
    for (const state of ["Onboarding", "Blocked", "Complete", "Canceled"] as const) {
      expect(isLiveEngagement(state)).toBe(false);
    }
  });
});

describe("the Overview shows each role type what applies to it (A59-033)", () => {
  it("shows people the org pays their rate and pay basis", () => {
    for (const roleType of ["crew", "staff", "contractor", "vendor", "artist"]) {
      expect(overviewRows(roleType)).toEqual([
        "org",
        "project",
        "role",
        "dates",
        "rate",
        "payBasis",
      ]);
    }
  });

  it("never shows a client or a sponsor a rate, a pay basis or a role", () => {
    for (const roleType of ["client", "sponsor"]) {
      const rows = overviewRows(roleType);
      expect(rows).not.toContain("rate");
      expect(rows).not.toContain("payBasis");
      expect(rows).not.toContain("role");
    }
    expect(overviewRows("client")).toContain("contractValue");
    expect(overviewRows("client")).toContain("approvalsWaiting");
    expect(overviewRows("sponsor")).toContain("sponsorshipFee");
    expect(overviewRows("sponsor")).toContain("entitlements");
  });

  it("gives clients and sponsors no worker tabs", () => {
    const worker = [
      "engagement.offer",
      "engagement.onboarding",
      "engagement.shifts",
      "engagement.timesheets",
      "engagement.per-diem",
      "engagement.travel-and-lodging",
      "engagement.time",
      "engagement.credentials",
    ];
    for (const roleType of ["client", "sponsor"] as const) {
      expect(tabs(roleType).filter((t) => worker.includes(t))).toEqual([]);
    }
  });
});

describe("paid work (A59-033)", () => {
  it("holds unless every engagement is a client or sponsor one", () => {
    expect(doesPaidWork([])).toBe(true);
    expect(doesPaidWork(["Crew"])).toBe(true);
    expect(doesPaidWork(["Client", "Vendor"])).toBe(true);
    expect(doesPaidWork(["Client"])).toBe(false);
    expect(doesPaidWork(["Sponsor", "Client"])).toBe(false);
  });

  it("hides payout, tax, timesheets and work details from people never paid", () => {
    const paid = [
      "settings.work-details",
      "settings.payout-and-tax",
      "money.timesheets",
      "money.tax-documents",
    ];
    const base = {
      standing: "account-owner" as const,
      companyAccount: true,
      platformDomain: true,
      desktop: true,
    };
    for (const id of [...paid, "settings.company.payout-and-tax"]) {
      expect(routeNeeds(sitemap, id, "paid-work")).toBe(true);
      expect(isNodeVisible(sitemap, id, navContext({ ...base, paidWork: true }))).toBe(true);
      expect(isNodeVisible(sitemap, id, navContext({ ...base, paidWork: false }))).toBe(false);
    }
    for (const id of ["settings.profile", "money.invoices", "money.payments", "work.engagements"]) {
      expect(routeNeeds(sitemap, id, "paid-work")).toBe(false);
      expect(isNodeVisible(sitemap, id, navContext({ ...base, paidWork: false }))).toBe(true);
    }
  });

  it("keeps the paid-work pages when nothing says otherwise", () => {
    const ctx = navContext({
      standing: "individual",
      companyAccount: false,
      platformDomain: true,
      desktop: false,
    });
    expect([...(ctx.conditions ?? [])]).toContain("paid-work");
  });
});
