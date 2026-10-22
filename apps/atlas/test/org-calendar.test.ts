import { describe, expect, it } from "vitest";
import { formatAlert } from "@/components/home/format-alert";
import { collectionState } from "@/lib/collection-kit/page";
import { addDays, weekStartOf } from "@/lib/crew/time";
import { type Alert, todayWindow } from "@/lib/home/data";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone, getOrgWeekStart, weekStartDay } from "@/lib/shell/time-zone";

// "Today" defaults come from the org's calendar (orgToday), passed in as a YYYY-MM-DD date, never
// from the UTC clock: on the last evening of a month in the Americas UTC is already in the next one.
describe("collection calendars on the org's calendar", () => {
  it("opens on the month of the org's date, whatever the UTC month is", () => {
    expect(collectionState({}, ["table", "calendar"], "2026-10-31").month).toBe("2026-10-01");
    expect(collectionState({}, ["calendar"], "2027-01-01").month).toBe("2027-01-01");
  });

  it("keeps a month the URL asks for", () => {
    expect(collectionState({ month: "2027-02" }, ["calendar"], "2026-10-31").month).toBe(
      "2027-02-01",
    );
  });

  it("ignores a malformed month and falls back to the org's month", () => {
    expect(collectionState({ month: "2027-2" }, ["calendar"], "2026-10-31").month).toBe(
      "2026-10-01",
    );
  });
});

// The org's calendar and payroll week come from the values the org set at its own scope, never from a
// member's own locale.time_zone or payroll.week_start, which resolved settings would rank first (A71).
function orgContext(stored: Record<string, string>) {
  const reads: string[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        is: () => builder,
        maybeSingle: () => {
          const key = String(filters["setting_key"]);
          reads.push(`${table}:${String(filters["scope_kind"])}:${key}`);
          const value = filters["scope_kind"] === "Organization" ? stored[key] : undefined;
          return Promise.resolve({
            data:
              value === undefined
                ? null
                : { value_text: value, value_boolean: null, value_integer: null },
            error: null,
          });
        },
      };
      return builder;
    },
  };
  return { ctx: { viewer: { db }, org: { id: "org-1" } } as unknown as OrgContext, reads };
}

describe("the org's time zone (locale.time_zone at the org)", () => {
  it("reads the org's own value, the row private.org_time_zone reads", async () => {
    const { ctx, reads } = orgContext({ "locale.time_zone": "America/Los_Angeles" });
    expect(await getOrgTimeZone(ctx)).toBe("America/Los_Angeles");
    expect(reads).toEqual(["setting_values:Organization:locale.time_zone"]);
  });

  it("is UTC when the org set none or an unknown zone", async () => {
    expect(await getOrgTimeZone(orgContext({}).ctx)).toBe("UTC");
    expect(await getOrgTimeZone(orgContext({ "locale.time_zone": "Mars/Olympus" }).ctx)).toBe(
      "UTC",
    );
  });
});

describe("the org's payroll week (payroll.week_start at the org)", () => {
  it("starts on the org's day, Sunday by default", async () => {
    expect(await getOrgWeekStart(orgContext({}).ctx)).toBe(0);
    const { ctx, reads } = orgContext({ "payroll.week_start": "monday" });
    expect(await getOrgWeekStart(ctx)).toBe(1);
    expect(reads).toEqual(["setting_values:Organization:payroll.week_start"]);
    expect(weekStartDay("sunday")).toBe(0);
    expect(weekStartDay(null)).toBe(0);
  });

  it("puts a new timesheet inside the org's pay periods", async () => {
    // 2027-06-16 is a Wednesday. On the org's Sunday weeks the timesheet is Sun 06-13 to Sat 06-19,
    // inside a biweekly period from Sun 06-06; a viewer's own Monday start would give Mon 06-14 to
    // Sun 06-20, across the period boundary, and never be paid.
    const week = weekStartOf("2027-06-16", await getOrgWeekStart(orgContext({}).ctx));
    expect([week, addDays(week, 6)]).toEqual(["2027-06-13", "2027-06-19"]);
  });
});

describe("Home alert dates", () => {
  const t = (key: string, values?: Record<string, string | number>) =>
    `${key}:${String(values?.["date"])}`;
  const mediumDate = (date: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(date);
  const alert = (kind: Alert["kind"], date: string): Alert => ({
    id: "a1",
    kind,
    severity: "medium",
    values: { key: "NWL-12", title: "Rigging plan", date },
    projectKey: "NWL",
    tab: "overview",
    at: date,
  });

  it("shows an overdue record's due instant on the org's calendar", () => {
    // Due at 22:00 in New York on Oct 21, already Oct 22 in UTC.
    const due = alert("overdue", "2026-10-22T02:00:00.000Z");
    expect(formatAlert(t, mediumDate, due, "America/New_York")).toBe("overdue:Oct 21, 2026");
    expect(formatAlert(t, mediumDate, due, "UTC")).toBe("overdue:Oct 22, 2026");
  });

  it("counts records due today on the org's calendar", () => {
    // 23:30 on Oct 21 in New York is already Oct 22 in UTC.
    const window = todayWindow("America/New_York", new Date("2026-10-22T03:30:00Z"));
    expect(window.from.toISOString()).toBe("2026-10-21T04:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-10-22T04:00:00.000Z");
    // The day the clocks go back is 25 hours long.
    const fallBack = todayWindow("America/New_York", new Date("2026-11-01T12:00:00Z"));
    expect(fallBack.to.getTime() - fallBack.from.getTime()).toBe(25 * 3_600_000);
  });

  it("shows a gate gap's calendar date as that date in every zone", () => {
    const gap = alert("gateGap", "2026-11-02");
    expect(formatAlert(t, mediumDate, gap, "Asia/Tokyo")).toBe("gateGap:Nov 2, 2026");
    expect(formatAlert(t, mediumDate, gap, "America/Los_Angeles")).toBe("gateGap:Nov 2, 2026");
  });
});
