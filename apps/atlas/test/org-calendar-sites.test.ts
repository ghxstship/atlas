import { afterEach, describe, expect, it, vi } from "vitest";
import { createPastedImportAction } from "@/app/[org]/import/actions";
import { weekSchedule } from "@/components/assets/units-view";
import { HolidayPresetForm } from "@/components/crew/holiday-preset-form";
import { dayFromToday } from "@/components/live/live-link-list";
import { contributions as a134 } from "@/components/settings/contributions/a134";
import { contributions as a30 } from "@/components/settings/contributions/a30";
import { linkZone } from "@/components/views/live-link-dialog";
import { createShareLinkAction, loadShareLinksAction } from "@/lib/files/share-actions";
import { loadDisplayLinksAction } from "@/lib/live-links/actions";
import { context, elements, viewerDb } from "./org-calendar-support";

/**
 * Atlas dates a person reads as "today" on the org's or the project's calendar, never the UTC date (A71,
 * RRR-116; 4.20 follows the 4.19 compliance fix). Every case runs at 22:00 on New Year's Eve 2026 in New
 * York, already 03:00 on 2027-01-01 in UTC, for an org on New York's calendar whose member keeps Tokyo's
 * (where it is noon on New Year's Day), so the UTC date and the member's own zone both give the wrong day.
 */

const NOW = "2027-01-01T03:00:00Z";
const ORG = { "locale.time_zone": "America/New_York" };
const MEMBER = { "locale.time_zone": "Asia/Tokyo" };

const state = vi.hoisted(() => ({
  ctx: null as unknown,
  calls: [] as { key: string; values?: Record<string, unknown> }[],
  pasted: [] as Record<string, unknown>[],
  shared: [] as Record<string, unknown>[],
  custody: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/platform/action-context", () => ({ contextFor: () => Promise.resolve(state.ctx) }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: () => Promise.resolve(state.ctx) }));
vi.mock("@/lib/shell/translate", () => ({
  getTranslate: () =>
    Promise.resolve((key: string, values?: Record<string, unknown>) => {
      state.calls.push({ key, ...(values ? { values } : {}) });
      return values ? `${key} ${JSON.stringify(values)}` : key;
    }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
  getFormatter: () =>
    Promise.resolve({
      dateTime: (d: Date, o?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", o).format(d),
      number: String,
    }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.test" }) }));
vi.mock("@/lib/aurora/suggestions", () => ({
  applySuggestions: () => Promise.resolve(),
  suggestionIds: () => [],
}));
vi.mock("@xos/data/imports", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createPastedImport: (_db: unknown, input: Record<string, unknown>) => {
    state.pasted.push(input);
    return Promise.resolve({ ok: true, data: "import-1" });
  },
}));
vi.mock("@xos/data/share-links", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listShareLinks: () => Promise.resolve({ ok: true, data: [{ id: "link-1" }] }),
  createShareLink: (_db: unknown, input: Record<string, unknown>) => {
    state.shared.push(input);
    return Promise.resolve({ ok: true, data: { id: "link-1", token: "t", accessCode: "c" } });
  },
}));
vi.mock("@xos/data/live-links", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listLiveLinks: () => Promise.resolve({ ok: true, data: [] }),
}));
vi.mock("@xos/data/show", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getRunOfShow: () => Promise.resolve({ ok: true, data: { timeZone: "America/Los_Angeles" } }),
}));
vi.mock("@xos/data/settings", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listOrgLegalAcceptances: () =>
    Promise.resolve({
      ok: true,
      data: [
        {
          documentSlug: "terms",
          documentVersion: "1.0",
          acceptedAt: NOW,
          personName: "Alice Morgan",
        },
      ],
    }),
}));
vi.mock("@xos/data/crew", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listHolidayCalendars: () =>
    Promise.resolve({
      ok: true,
      data: [
        {
          id: "cal-1",
          name: "United States",
          venues: [],
          holidays: [],
          workedHolidayMultiplier: null,
        },
      ],
    }),
}));
vi.mock("@xos/data/projects", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listVenues: () => Promise.resolve({ ok: true, data: [] }),
}));
vi.mock("@xos/data/assets", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listAssetCustody: () => Promise.resolve({ ok: true, data: state.custody }),
}));

function at(now: string, org: Record<string, string> = ORG) {
  vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
  state.ctx = context(viewerDb(org, MEMBER), [
    "org.payroll.write",
    "org.legal.accept",
    "assets.read",
  ]);
}

afterEach(() => {
  vi.useRealTimers();
  state.calls.length = 0;
  state.pasted.length = 0;
  state.shared.length = 0;
  state.custody.length = 0;
});

describe("a pasted import's file name (import/actions.ts)", () => {
  it("is named for today on the org's calendar", async () => {
    at(NOW);
    const form = new FormData();
    form.set("org", "northwind");
    form.set("target", "contacts");
    form.set("text", "name\nAda");
    await createPastedImportAction({}, form);
    expect(state.pasted[0]?.["filename"]).toContain('"date":"2026-12-31"');
  });
});

describe("a legal acceptance's date (Settings, Legal)", () => {
  it("is the day it was accepted on the org's calendar", async () => {
    at(NOW);
    const panel = a30.find((c) => c.node === "settings.legal")?.Panel;
    if (!panel) throw new Error("A30 has no legal panel");
    await panel({ ctx: state.ctx } as never);
    const line = state.calls.find((c) => c.key === "settings.legal.acceptedBy");
    expect(line?.values?.["date"]).toBe("2026-12-31");
  });
});

describe("the holiday presets' year (Settings, Payroll and Time Off)", () => {
  it("offers this year on the org's calendar", async () => {
    at(NOW);
    const panel = a134.find((c) => c.order === 40)?.Panel;
    if (!panel) throw new Error("A134 has no holiday calendars panel at order 40");
    const tree = await panel({ ctx: state.ctx } as never);
    const preset = elements(tree).find((e) => e.type === HolidayPresetForm);
    expect(preset?.props["thisYear"]).toBe(2026);
  });
});

describe("live link and share link date bounds", () => {
  it("count from today in the link's zone", () => {
    at(NOW);
    expect(dayFromToday(0, "America/New_York")).toBe("2026-12-31");
    expect(dayFromToday(1, "America/New_York")).toBe("2027-01-01");
    expect(dayFromToday(90, "America/New_York")).toBe("2027-03-31");
    expect(dayFromToday(1, "Asia/Tokyo")).toBe("2027-01-02");
  });

  it("follow the saved view link's project, the first until one is picked", () => {
    const projects = [
      { id: "p1", key: "NY", name: "New York", timeZone: "America/New_York" },
      { id: "p2", key: "TK", name: "Tokyo", timeZone: "Asia/Tokyo" },
    ];
    expect(linkZone(projects, "TK")).toBe("Asia/Tokyo");
    expect(linkZone(projects, "")).toBe("America/New_York");
    expect(linkZone([], "")).toBe("UTC");
  });

  it("give a display link dialog its running order's project zone", async () => {
    at(NOW);
    const result = await loadDisplayLinksAction(
      "northwind",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(result.ok && result.data.timeZone).toBe("America/Los_Angeles");
  });

  it("give the share panel the org's zone, never the member's", async () => {
    at(NOW);
    const result = await loadShareLinksAction("northwind", "00000000-0000-4000-8000-000000000001");
    expect(result.ok && result.data.timeZone).toBe("America/New_York");
  });

  it("end a shared file's picked day on the org's calendar", async () => {
    at(NOW);
    await createShareLinkAction("northwind", {
      attachmentId: "00000000-0000-4000-8000-000000000001",
      expiresOn: "2027-01-05",
      recipientEmail: "",
      note: "",
    });
    // 23:59:59 on 2027-01-05 in New York, not 23:59:59 UTC, five hours early.
    expect(state.shared[0]?.["expiresAt"]).toBe("2027-01-06T04:59:59.000Z");
  });
});

describe("a unit's week of custody (Assets, Units, resource schedule)", () => {
  it("counts a handover on the evening of the org's day it happened", async () => {
    // Handed to a crew member at 21:00 on Thursday 2026-12-31 in New York, 02:00 on Friday in UTC.
    at(NOW);
    state.custody.push({
      unitId: "u1",
      assetTag: "AT-1",
      className: "Lights",
      since: "2027-01-01T02:00:00Z",
      membershipId: "m1",
      engagementId: null,
      projectKey: "NY",
      custodianName: "Alice Morgan",
    });
    const format = {
      dateTime: (d: Date, o?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", o).format(d),
    };
    const week = await weekSchedule(
      state.ctx as never,
      [{ id: "u1", assetTag: "AT-1", className: "Lights" } as never],
      format as never,
      (key: string) => key,
      "2026-12-31",
    );
    expect(week.people[0]?.shifts.map((s) => s.day)).toEqual(["2026-12-31"]);
  });
});
