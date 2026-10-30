import { todayIn } from "@xos/data/calendar";
import { getMessages, locales } from "@xos/i18n";
import { EXTERNAL_AUDIENCES, TABLE_RULES, type Row } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { sourcesFor } from "../src/data/sources";
import { moreMenu, NATIVE_MORE, type EngagementSummary } from "../src/domain/access";
import { daysUntil, formatCalendarDay, formatInstant, todayOn } from "../src/domain/dates";
import {
  engagementFor,
  enumKey,
  EXTERNAL_PAGES,
  gatewayTabUrl,
  isExternalPage,
  onboardingStanding,
  type ExternalItem,
  type ExternalPageId,
  type ExternalSection,
  type Fact,
  type PageInput,
} from "../src/domain/external";
import { factsText } from "../src/domain/facts";

const PROJECT = "p-1";
const OTHER = "p-2";
const ZONE = "America/New_York";
// 22:30 on June 10 in New York is already June 11 in UTC: the project's calendar decides "today".
const NOW = new Date("2027-06-11T02:30:00Z");

const engagement = (over: Partial<EngagementSummary>): EngagementSummary => ({
  id: "e-crew",
  orgId: "o-1",
  orgName: "Demo Productions",
  projectId: PROJECT,
  projectName: "Northwind Summer Series",
  roleType: "crew",
  state: "Active",
  ...over,
});

const ENGAGEMENTS: readonly EngagementSummary[] = [
  engagement({}),
  engagement({ id: "e-contractor", roleType: "contractor" }),
  engagement({ id: "e-artist", roleType: "artist" }),
  engagement({ id: "e-client", roleType: "client" }),
  engagement({ id: "e-sponsor", roleType: "sponsor" }),
  engagement({ id: "e-old", projectId: OTHER, state: "Complete" }),
];

const r = (id: string, fields: Record<string, unknown>): Row => ({ id, ...fields }) as Row;

const TABLES: Readonly<Record<string, readonly Row[]>> = {
  timesheets: [
    r("ts-1", {
      engagement_id: "e-crew",
      project_id: PROJECT,
      project_name: "Northwind Summer Series",
      period_start: "2027-06-07",
      period_end: "2027-06-13",
      timesheet_state: "Submitted",
      worked_minutes: 1830,
      submitted_at: "2027-06-10T23:15:00Z",
      decided_at: null,
    }),
    r("ts-other", { engagement_id: "e-old", project_id: OTHER, period_start: "2027-01-01" }),
  ],
  per_diems: [
    r("pd-1", {
      engagement_id: "e-crew",
      project_id: PROJECT,
      day: "2027-06-10",
      amount_minor: 5000,
      currency_code: "USD",
    }),
    r("pd-2", {
      engagement_id: "e-crew",
      project_id: PROJECT,
      day: "2027-06-11",
      amount_minor: 5000,
      currency_code: "USD",
    }),
  ],
  travel_segments: [
    r("tr-1", {
      engagement_id: "e-crew",
      project_id: PROJECT,
      travel_mode: "Flight",
      operator_name: "Coastal Air",
      service_identifier: "CA 210",
      confirmation_identifier: "QX7PLM",
      departs_from: "LAX",
      departs_at: "2027-06-09T16:00:00Z",
      departs_time_zone: "America/Los_Angeles",
      arrives_at_place: "MIA",
      arrives_at: "2027-06-10T00:05:00Z",
      arrives_time_zone: "America/New_York",
    }),
  ],
  lodging: [
    r("lo-1", {
      project_id: PROJECT,
      hotel_name: "Harbor Inn",
      block_title: "Crew block",
      person_id: "person-1",
      check_in_on: "2027-06-09",
      check_out_on: "2027-06-12",
    }),
    r("lo-party", {
      project_id: PROJECT,
      hotel_name: "Harbor Inn",
      person_id: "someone-else",
      check_in_on: "2027-06-09",
    }),
  ],
  onboarding_items: [
    r("ob-done", {
      engagement_id: "e-crew",
      name: "W-9",
      item_kind: "Tax Form",
      satisfied: true,
      passes: true,
    }),
    r("ob-todo", {
      engagement_id: "e-crew",
      name: "Rigging certificate",
      item_kind: "Certification",
      is_blocking: true,
      satisfied: false,
    }),
    r("ob-wait", {
      engagement_id: "e-crew",
      name: "Safety briefing",
      item_kind: "Training",
      satisfied: false,
      submitted_at: "2027-06-08T12:00:00Z",
    }),
    r("ob-expired", {
      engagement_id: "e-crew",
      name: "Background check",
      item_kind: "Background Check",
      satisfied: true,
      expires_on: "2027-06-09",
    }),
  ],
  purchase_orders: [
    r("po-1", {
      project_id: PROJECT,
      org_name: "Demo Productions",
      po_number: 42,
      currency_code: "USD",
      po_state: "Sent",
      total_minor: 250000,
      sent_at: "2027-06-01T15:00:00Z",
      acknowledged_at: null,
    }),
  ],
  po_lines: [
    r("pl-2", {
      purchase_order_id: "po-1",
      project_id: PROJECT,
      line_number: 2,
      description: "Truss",
      quantity: 4,
      unit_basis: "ea",
      amount_minor: 50000,
    }),
    r("pl-1", {
      purchase_order_id: "po-1",
      project_id: PROJECT,
      line_number: 1,
      description: "Motors",
      quantity: 2,
      unit_basis: "ea",
      amount_minor: 200000,
    }),
  ],
  deliveries: [
    r("dl-1", {
      project_id: PROJECT,
      direction: "Inbound",
      tracking_identifier: "1Z999",
      ships_at: "2027-06-08T13:00:00Z",
      arrives_at: "2027-06-09T14:00:00Z",
    }),
  ],
  shared_records: [
    r("rec-1", {
      project_id: PROJECT,
      record_kind: "Approval",
      record_state: "Proposed",
      title: "Stage plot sign-off",
      due_at: "2027-06-12T21:00:00Z",
      time_zone: ZONE,
    }),
    r("rec-2", { project_id: PROJECT, record_kind: "Shift", title: "Not a submittal" }),
  ],
  time_entries: [
    r("te-1", {
      engagement_id: "e-contractor",
      project_id: PROJECT,
      clock_in: "2027-06-10T12:00:00Z",
      clock_out: "2027-06-10T20:30:00Z",
      break_minutes: 30,
      source: "Mobile",
    }),
    r("te-member", { membership_id: "m-1", project_id: PROJECT, clock_in: "2027-06-10T12:00:00Z" }),
  ],
  deliverables: [
    r("dv-late", {
      engagement_id: "e-contractor",
      title: "Lighting plot",
      due_at: "2027-06-10T03:00:00Z",
      deliverable_state: "Open",
      fee_minor: 120000,
      currency_code: "USD",
    }),
    r("dv-ok", {
      engagement_id: "e-contractor",
      title: "Final renders",
      due_at: "2027-06-12T21:00:00Z",
      deliverable_state: "Returned",
      return_reason: "Wrong stage width",
    }),
  ],
  advance_packets: [
    r("ap-1", { project_id: PROJECT, title: "Artist advance", due_at: "2027-06-05T21:00:00Z" }),
  ],
  advance_sections: [
    r("as-1", {
      advance_packet_id: "ap-1",
      project_id: PROJECT,
      position: 1,
      title: "Hospitality",
    }),
    r("as-2", { advance_packet_id: "ap-1", project_id: PROJECT, position: 2, title: "Input list" }),
  ],
  advance_submissions: [
    r("asub-1", {
      advance_section_id: "as-1",
      project_id: PROJECT,
      submitted_at: "2027-06-02T18:00:00Z",
      review_outcome: "Accepted",
    }),
  ],
  riders: [r("ri-1", { project_id: PROJECT, title: "Technical rider" })],
  rider_lines: [
    r("rl-1", {
      rider_id: "ri-1",
      project_id: PROJECT,
      description: "Two wedges",
      quantity: 2,
      fulfilled_at: "2027-06-09T12:00:00Z",
    }),
    r("rl-2", {
      rider_id: "ri-1",
      project_id: PROJECT,
      description: "Drum riser",
      quantity: 1,
      fulfilled_at: null,
    }),
  ],
  settlements: [
    r("st-1", {
      engagement_id: "e-artist",
      project_id: PROJECT,
      title: "Settlement 1",
      currency_code: "USD",
      settlement_state: "Submitted",
      net_minor: 230000,
      settled_on: "2027-06-11",
    }),
  ],
  settlement_lines: [
    r("sl-1", {
      settlement_id: "st-1",
      project_id: PROJECT,
      line_number: 1,
      line_kind: "Guarantee",
      description: "Guarantee",
      amount_minor: 250000,
    }),
    r("sl-2", {
      settlement_id: "st-1",
      project_id: PROJECT,
      line_number: 2,
      line_kind: "Deduction",
      description: "Hospitality overage",
      amount_minor: 20000,
    }),
  ],
  shared_reports: [
    r("sr-1", {
      engagement_id: "e-client",
      project_id: PROJECT,
      title: "Show recap",
      shared_at: "2027-06-10T22:00:00Z",
      expires_at: "2027-07-10T22:00:00Z",
      export_format: "PDF",
      row_count: 12,
    }),
  ],
  sponsor_entitlements: [
    r("se-1", {
      project_id: PROJECT,
      description: "Logo on the LED wall",
      quantity: 20,
      due_on: "2027-06-09",
      fulfilled_at: null,
    }),
    r("se-2", {
      project_id: PROJECT,
      description: "Sampling tent",
      due_on: "2027-06-10",
      fulfilled_at: "2027-06-10T15:00:00Z",
    }),
  ],
  engagement_documents: [
    r("doc-1", {
      engagement_id: "e-sponsor",
      document_kind: "Proof of Performance",
      title: "Night 1 photo report",
      engagement_document_state: "Sent",
    }),
  ],
};

const input: PageInput = {
  rows: (table) => TABLES[table] ?? [],
  projectId: PROJECT,
  personId: "person-1",
  engagements: ENGAGEMENTS,
  zoneOf: (project) => (project === PROJECT ? ZONE : null),
  todayOf: (project) => todayIn(project === PROJECT ? ZONE : "UTC", NOW),
};

const build = (id: ExternalPageId) => EXTERNAL_PAGES[id].build(input);
const items = (sections: readonly ExternalSection[], id: string) =>
  sections.find((s) => s.id === id)?.items ?? [];
const instants = (item: ExternalItem | undefined) =>
  (item?.facts ?? []).filter((f): f is Extract<Fact, { kind: "instant" }> => f.kind === "instant");

describe("the external More screens are native (A65-011 part 2)", () => {
  it("covers every external More entry with a page, and Compass lists them as its own", () => {
    for (const audience of EXTERNAL_AUDIENCES) {
      for (const entry of moreMenu(audience)) {
        expect(NATIVE_MORE.has(entry.id), `${audience} ${entry.id}`).toBe(true);
        // Project details (R5) reads online only, so it is a screen of its own and never an offline external page.
        if (
          ["offline-queue", "profile", "settings", "run-of-show", "project-details"].includes(
            entry.id,
          )
        )
          continue;
        expect(isExternalPage(entry.id), entry.id).toBe(true);
        expect(EXTERNAL_PAGES[entry.id as ExternalPageId].audiences, entry.id).toContain(audience);
      }
    }
  });

  it("downloads and admits every table a page reads, for each role type it serves", () => {
    for (const page of Object.values(EXTERNAL_PAGES)) {
      for (const audience of page.audiences) {
        const tables = sourcesFor(audience).map((s) => s.table);
        for (const table of page.tables) {
          expect(tables, `${audience} ${table}`).toContain(table);
          const rule = TABLE_RULES.find((x) => x.table === table);
          expect(
            rule?.anyOf.some((a) => !a.audiences || a.audiences.includes(audience)),
            `${audience} ${table}`,
          ).toBe(true);
        }
      }
    }
    // A crew phone never asks for a vendor's purchase orders.
    expect(sourcesFor("crew").map((s) => s.table)).not.toContain("purchase_orders");
    expect(sourcesFor("vendor").map((s) => s.table)).not.toContain("timesheets");
  });

  it("opens the engagement's own Gateway tab for the actions", () => {
    const page = EXTERNAL_PAGES["time-entries"];
    expect(engagementFor(page, ENGAGEMENTS, PROJECT)?.id).toBe("e-contractor");
    expect(engagementFor(EXTERNAL_PAGES.timesheets, ENGAGEMENTS, OTHER)?.id).toBe("e-old");
    expect(engagementFor(EXTERNAL_PAGES.reports, ENGAGEMENTS, OTHER)).toBeNull();
    expect(gatewayTabUrl("https://gateway.test/", "ENG-01ABC", page.gatewayTab)).toBe(
      "https://gateway.test/work/engagements/ENG-01ABC/time",
    );
  });
});

describe("dates on the right calendar (A71)", () => {
  it("takes today from the project's calendar, not UTC's", () => {
    expect(todayIn(ZONE, NOW)).toBe("2027-06-10");
    expect(todayIn("UTC", NOW)).toBe("2027-06-11");
    expect(daysUntil("2027-06-11", "2027-06-10")).toBe(1);
    // Per diem marks June 10 as today, as the project sees it.
    const days = items(build("per-diem"), "per-diem");
    expect(days.find((i) => i.id === "pd-1")?.tag?.key).toBe("compassExternal.today");
    expect(days.find((i) => i.id === "pd-2")?.tag).toBeUndefined();
    expect(todayOn("Not/AZone", NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shows calendar dates as written and instants in the zone of their place", () => {
    expect(formatCalendarDay("2027-06-10", "en-US")).toBe("Thu, Jun 10");
    const flight = items(build("travel-and-lodging"), "travel")[0];
    expect(instants(flight).map((f) => f.zone)).toEqual([
      "America/Los_Angeles",
      "America/New_York",
    ]);
    // 16:00 UTC departs LAX at 9:00 local; the arrival is 8:05 PM in Miami.
    expect(
      formatInstant("2027-06-09T16:00:00Z", "America/Los_Angeles", "en-US", "America/New_York"),
    ).toBe("Wed, Jun 9, 9:00 AM PDT");
    expect(formatInstant("2027-06-10T00:05:00Z", ZONE, "en-US", ZONE)).toBe("Wed, Jun 9, 8:05 PM");
    const sheet = items(build("timesheets"), "timesheets")[0];
    expect(instants(sheet).map((f) => f.zone)).toEqual([ZONE]);
    expect(sheet?.facts[0]).toEqual({ kind: "range", from: "2027-06-07", to: "2027-06-13" });
  });

  it("counts overdue on the project's calendar", () => {
    const due = items(build("deliverables"), "deliverables");
    // Due 23:00 on June 9 in New York; on June 10 there it is overdue.
    expect(due.find((i) => i.id === "dv-late")?.tag).toEqual({
      key: "compassExternal.overdue",
      tone: "danger",
    });
    expect(due.find((i) => i.id === "dv-ok")?.tag?.key).toBe(
      "gateway.enums.deliverableState.returned",
    );
    const entitlements = items(build("proof-of-performance"), "entitlements");
    expect(entitlements.map((i) => i.tag?.key)).toEqual([
      "compassExternal.overdue",
      "compassExternal.proof.delivered",
    ]);
    expect(
      onboardingStanding(r("x", { satisfied: true, expires_on: "2027-06-10" }), "2027-06-10"),
    ).toBe("verified");
    expect(
      onboardingStanding(r("x", { satisfied: true, expires_on: "2027-06-09" }), "2027-06-10"),
    ).toBe("expired");
  });
});

describe("each page", () => {
  it("keeps to the current project and to the person's own rows", () => {
    expect(items(build("timesheets"), "timesheets").map((i) => i.id)).toEqual(["ts-1"]);
    expect(items(build("travel-and-lodging"), "lodging").map((i) => i.id)).toEqual(["lo-1"]);
    expect(items(build("time-entries"), "time-entries").map((i) => i.id)).toEqual(["te-1"]);
    expect(items(build("submittals"), "submittals").map((i) => i.id)).toEqual(["rec-1"]);
  });

  it("lists onboarding with what is left first and its progress", () => {
    const [onboarding] = build("onboarding");
    expect(onboarding?.items.map((i) => i.id)).toEqual([
      "ob-todo",
      "ob-expired",
      "ob-wait",
      "ob-done",
    ]);
    expect(onboarding?.progress).toEqual({ done: 1, total: 4 });
    expect(onboarding?.items[0]?.facts).toContainEqual({
      kind: "label",
      key: "compassExternal.onboarding.blocking",
    });
  });

  it("groups lines under their order, rider and settlement, deductions as minus", () => {
    const po = items(build("purchase-orders"), "purchase-orders")[0];
    expect(po?.lines?.map((l) => l.id)).toEqual(["pl-1", "pl-2"]);
    expect(po?.facts[0]).toEqual({ kind: "money", minor: 250000, currency: "USD" });
    const rider = items(build("rider"), "rider")[0];
    expect(rider?.facts[0]).toEqual({
      kind: "label",
      key: "compassExternal.rider.progress",
      values: { done: 1, total: 2 },
    });
    const settlement = items(build("settlement"), "settlement")[0];
    expect(settlement?.lines?.[1]?.facts).toContainEqual({
      kind: "money",
      minor: -20000,
      currency: "USD",
    });
    const advance = items(build("advance-summary"), "advance")[0];
    expect(advance?.facts[0]).toEqual({
      kind: "label",
      key: "compassExternal.advance.progress",
      values: { done: 1, total: 2 },
    });
  });

  it("works out hours from the clock, less breaks", () => {
    const entry = items(build("time-entries"), "time-entries")[0];
    expect(entry?.facts).toContainEqual({ kind: "minutes", minutes: 480 });
    expect(entry?.title).toBe("");
  });

  it("reads each fact as words, a label joined to its value", () => {
    const t = (key: string, values: Readonly<Record<string, string | number>>) =>
      `${key}${Object.keys(values).length ? JSON.stringify(values) : ""}`;
    const flight = items(build("travel-and-lodging"), "travel")[0];
    const words = factsText(flight?.facts ?? [], t, "en-US", "America/New_York");
    expect(words).toEqual([
      "Coastal Air CA 210",
      "compassExternal.travel.departs Wed, Jun 9, 9:00 AM PDT",
      "compassExternal.travel.arrives Wed, Jun 9, 8:05 PM",
      'compassExternal.travel.confirmation{"code":"QX7PLM"}',
    ]);
    // A person who shows times in their own zone (me.time_zone_display) sees both ends there.
    const own = factsText(
      flight?.facts ?? [],
      t,
      "en-US",
      "America/New_York",
      () => "America/New_York",
    );
    expect(own.slice(1, 3)).toEqual([
      "compassExternal.travel.departs Wed, Jun 9, 12:00 PM",
      "compassExternal.travel.arrives Wed, Jun 9, 8:05 PM",
    ]);
    expect(factsText([{ kind: "minutes", minutes: 125 }], t, "en-US")).toEqual([
      'compassExternal.duration{"hours":2,"minutes":5}',
    ]);
  });
});

describe("external copy", () => {
  const keysOf = (sections: readonly ExternalSection[]): string[] => {
    const out: string[] = [];
    const walk = (item: ExternalItem) => {
      if (item.tag) out.push(item.tag.key);
      for (const f of item.facts) if (f.kind === "label") out.push(f.key);
      for (const line of item.lines ?? []) walk(line);
    };
    for (const s of sections) {
      out.push(s.titleKey);
      s.items.forEach(walk);
    }
    return out;
  };
  const lookup = (catalog: unknown, key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        catalog,
      );

  it.each(locales)(
    "has every message the pages use in %s, Gateway's state labels included",
    (locale) => {
      const catalog = getMessages(locale);
      const keys = new Set([
        ...Object.values(EXTERNAL_PAGES).flatMap((p) => [p.emptyKey, ...keysOf(p.build(input))]),
        "compassExternal.between",
        "compassExternal.duration",
        "compassExternal.progress",
        "compassExternal.gateway.actions",
        "compassExternal.gateway.time",
      ]);
      expect([...keys].filter((k) => typeof lookup(catalog, k) !== "string")).toEqual([]);
      for (const page of Object.keys(EXTERNAL_PAGES)) {
        const nav = `nav.compass.more.${page.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`;
        expect(typeof lookup(catalog, nav), nav).toBe("string");
      }
    },
  );

  it("keys stored enum values the way Gateway does", () => {
    expect(enumKey("Proof of Performance")).toBe("proofOfPerformance");
    expect(enumKey("Submitted")).toBe("submitted");
    expect(enumKey("to-do")).toBe("toDo");
  });
});
