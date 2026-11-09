import { getMessages } from "@xos/i18n";
import { CLASH_RULES, classifyClash, type ClashCandidate } from "@xos/data/schedule-clashes";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { clashHref, clashSentence, linkLabelKey, ruleNameKey } from "../lib/schedule/clash-copy";
import {
  cellOfWindow,
  normalizeTimeCell,
  readDurationCell,
  readTbcCell,
  readTimeCell,
} from "../lib/schedule/grid-time";

/**
 * B4 (G-46, G-47): every clash rule reads as a sentence in en-US and es-US, composed here from its rule and params,
 * with no brace or "undefined" left, and links to a page where it is fixed. The grid's time cells read shorthand on
 * the project's clock.
 */

type Tree = { readonly [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const t =
  (locale: "en-US" | "es-US") => (key: string, values?: Record<string, string | number>) => {
    const schedule = (getMessages(locale) as unknown as Record<string, Tree>)["schedule"] as Tree;
    const source = lookup(schedule, key);
    if (source === undefined) throw new Error(`missing schedule.${key} (${locale})`);
    return String(new IntlMessageFormat(source, locale).format(values as never));
  };

const base: ClashCandidate = {
  rule: "changeover",
  projectId: "p1",
  otherProjectId: "p2",
  day: "2027-06-05",
  subjectTable: "shifts",
  subjectId: "s1",
  otherTable: "travel_segments",
  otherId: "t1",
  partyKind: "person",
  partyId: "x",
  partyName: "Arturo Bell",
  otherPartyName: "Quinn Ashby",
  startsAt: "2027-06-06T01:00:00Z",
  endsAt: "2027-06-06T02:00:00Z",
  otherStartsAt: "2027-06-06T01:30:00Z",
  otherEndsAt: "2027-06-06T02:00:00Z",
  gapMinutes: 10,
  tbc: false,
  draft: false,
};

describe("clash sentences", () => {
  for (const locale of ["en-US", "es-US"] as const) {
    it.each(CLASH_RULES)(`reads %s in ${locale}`, (rule) => {
      for (const gap of [10, -10]) {
        const clash = classifyClash(
          { ...base, rule, gapMinutes: gap },
          { changeoverMinutes: 15, travelBufferMinutes: 120 },
        );
        if (!clash) continue;
        const sentence = clashSentence(
          clash,
          t(locale),
          () => "9:00 PM",
          () => "Jun 5",
        );
        expect(sentence).not.toMatch(/[{}]|undefined/);
        expect(sentence.length).toBeGreaterThan(10);
        expect(t(locale)(ruleNameKey(rule))).not.toMatch(/[{}]/);
        for (const link of clash.links) {
          expect(clashHref("demo", link)).toMatch(/^\/demo\//);
          expect(t(locale)(linkLabelKey(link))).not.toBe("");
        }
      }
    });
  }

  it("names the artists and the minimum of a short changeover", () => {
    const clash = classifyClash(base, { changeoverMinutes: 15, travelBufferMinutes: 120 });
    expect(
      clash &&
        clashSentence(
          clash,
          t("en-US"),
          () => "9:00 PM",
          () => "Jun 5",
        ),
    ).toBe("10 min changeover between Arturo Bell and Quinn Ashby; the minimum is 15");
    expect(
      clash &&
        clashSentence(
          clash,
          t("es-US"),
          () => "21:00",
          () => "5 jun",
        ),
    ).toBe("Cambio de 10 min entre Arturo Bell y Quinn Ashby; el mínimo es 15");
  });
});

describe("grid time cells", () => {
  it("reads shorthand onto the project's wall clock, rolling an early end to the next day", () => {
    expect(readTimeCell("8a-10:30a", "2027-06-01", "America/New_York", "en-US")).toEqual({
      startsAt: "2027-06-01T12:00:00.000Z",
      endsAt: "2027-06-01T14:30:00.000Z",
      dueAt: null,
    });
    expect(readTimeCell("10p-2a", "2027-06-01", "America/New_York", "en-US")?.endsAt).toBe(
      "2027-06-02T06:00:00.000Z",
    );
    expect(readTimeCell("830p", "2027-06-01", "America/New_York", "en-US")?.dueAt).toBe(
      "2027-06-02T00:30:00.000Z",
    );
    expect(readTimeCell("20 h", "2027-06-01", "America/New_York", "es-US")?.dueAt).toBe(
      "2027-06-02T00:00:00.000Z",
    );
    expect(readTimeCell("8 a. m.", "2027-06-01", "America/New_York", "es-US")?.dueAt).toBe(
      "2027-06-01T12:00:00.000Z",
    );
    expect(readTimeCell("00:15 +1", "2027-06-05", "America/New_York", "en-US")?.dueAt).toBe(
      "2027-06-06T04:15:00.000Z",
    );
    expect(readTimeCell("whenever", "2027-06-01", "America/New_York", "en-US")).toBeNull();
  });

  it("keeps a normalized label and reads it back", () => {
    expect(normalizeTimeCell("8a-10:30a", "en-US")).toBe("08:00–10:30");
    const label = cellOfWindow(
      { startsAt: "2027-06-02T02:00:00Z", endsAt: "2027-06-02T06:00:00Z", dueAt: null },
      "America/New_York",
    );
    expect(label).toBe("22:00–02:00 +1");
    expect(readTimeCell(label ?? "", "2027-06-01", "America/New_York", "en-US")?.endsAt).toBe(
      "2027-06-02T06:00:00.000Z",
    );
    expect(
      cellOfWindow(
        { startsAt: null, endsAt: null, dueAt: "2027-06-06T04:15:00Z" },
        "America/New_York",
        "2027-06-05",
      ),
    ).toBe("00:15 +1");
  });

  it("reads lengths and TBC", () => {
    expect(readDurationCell("1h30")).toBe(90);
    expect(readDurationCell("3000")).toBeNull();
    expect(readTbcCell("TBC")).toBe(true);
    expect(readTbcCell("sí")).toBe(true);
    expect(readTbcCell(null)).toBe(false);
  });
});
