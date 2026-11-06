import { describe, expect, it } from "vitest";
import {
  ENGAGEMENT_DOCUMENT_MERGE_FIELDS,
  mergeEngagementDocument,
  unknownMergeFields,
  usesRate,
  type MergeFacts,
} from "../src/engagement-document-merge.ts";

const FACTS: MergeFacts = {
  partyName: "Ana Ruiz",
  orgName: "Northwind Live",
  projectName: "Summer Series",
  projectKey: "NWL",
  projectTimeZone: "America/New_York",
  roleTitle: "Rigger",
  opportunityTitle: "Summer riggers",
  startDate: "2027-06-01",
  endDate: "2027-06-03",
  rate: { minor: 99000, currency: "USD", exponent: 2 },
  payBasis: "Day rate",
  shifts: [
    {
      startsAt: "2027-06-02T12:00:00Z",
      endsAt: "2027-06-02T20:00:00Z",
      timeZone: "America/New_York",
      jobTitle: "Rigger",
    },
    {
      startsAt: "2027-06-01T15:00:00Z",
      endsAt: "2027-06-01T23:30:00Z",
      timeZone: "America/Los_Angeles",
      jobTitle: "Rigger",
    },
  ],
};

const every = ENGAGEMENT_DOCUMENT_MERGE_FIELDS.map((f) => `{{${f}}}`).join("|");
const NOW = new Date("2027-05-15T12:00:00Z");

describe("mergeEngagementDocument (B10)", () => {
  it("fills every field in en-US and es-US", () => {
    for (const locale of ["en-US", "es-US"]) {
      const merged = mergeEngagementDocument(
        { title: "{{party.name}}", body: every },
        FACTS,
        locale,
        NOW,
      );
      expect(merged.missing, locale).toEqual([]);
      expect(merged.body, locale).not.toContain("{{");
      expect(merged.title).toBe("Ana Ruiz");
    }
    const en = mergeEngagementDocument(
      { title: "t", body: "{{engagement.rate}} {{engagement.start_date}}" },
      FACTS,
      "en-US",
      NOW,
    );
    expect(en.body).toBe("$990.00 June 1, 2027");
    const es = mergeEngagementDocument(
      { title: "t", body: "{{engagement.start_date}}" },
      FACTS,
      "es-US",
      NOW,
    );
    expect(es.body).toContain("junio");
  });

  it("merges optional fields empty and lists the rest as missing", () => {
    const merged = mergeEngagementDocument(
      {
        title: "T",
        body: "[{{engagement.end_date}}][{{engagement.opportunity}}][{{engagement.role}}]",
      },
      { ...FACTS, endDate: null, opportunityTitle: null, roleTitle: null },
      "en-US",
      NOW,
    );
    expect(merged.missing).toEqual(["engagement.role"]);
    expect(merged.body).toBe("[][][{{engagement.role}}]");
  });

  it("treats a masked rate and unreadable shifts as missing", () => {
    const merged = mergeEngagementDocument(
      {
        title: "T",
        body: "{{engagement.rate}} {{shifts.count}} {{shifts.table}} {{shifts.total_hours}} {{shifts.first_call}}",
      },
      { ...FACTS, rate: null, shifts: null },
      "en-US",
      NOW,
    );
    expect(merged.missing).toEqual([
      "engagement.rate",
      "shifts.count",
      "shifts.first_call",
      "shifts.table",
      "shifts.total_hours",
    ]);
  });

  it("writes one table line a shift, each in its own zone, earliest first", () => {
    const { body } = mergeEngagementDocument(
      { title: "T", body: "{{shifts.table}}" },
      FACTS,
      "en-US",
      NOW,
    );
    const lines = body.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Tuesday");
    expect(lines[0]).toContain("8:00");
    expect(lines[0]).toContain("PDT");
    expect(lines[1]).toContain("8:00");
    expect(lines[1]).toContain("EDT");
    expect(lines[1]).toContain("Rigger");
    expect(
      mergeEngagementDocument({ title: "T", body: "{{shifts.total_hours}}" }, FACTS, "en-US", NOW)
        .body,
    ).toBe("16.5");
  });

  it("means the project's day by today", () => {
    // 01:00 UTC on June 2 is still June 1 in New York, and June 2 in Tokyo and in UTC.
    const at = new Date("2027-06-02T01:00:00Z");
    const merge = (zone: string) =>
      mergeEngagementDocument(
        { title: "T", body: "{{today}}" },
        { ...FACTS, projectTimeZone: zone },
        "en-US",
        at,
      ).body;
    expect(merge("America/New_York")).toBe("June 1, 2027");
    expect(merge("Asia/Tokyo")).toBe("June 2, 2027");
  });

  it("reads the rate from the body and checks the closed list", () => {
    expect(usesRate("Pay: {{ engagement.rate }}")).toBe(true);
    expect(usesRate("{{project.name}}")).toBe(false);
    expect(unknownMergeFields("{{project.name}} {{engagement.bonus}}")).toEqual([
      "engagement.bonus",
    ]);
  });
});
