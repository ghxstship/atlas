import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/gateway.json";
import esUS from "../../../packages/i18n/messages/es-US/gateway.json";
import { fyiSentence } from "@/lib/fyi-sentence";
import type { Translate } from "@/lib/shell/translate";

/**
 * Gateway's For Your Information row for a crisis alert (6800): an engaged external person reads it here, so it must carry
 * what to do, and its all-clear must not read like the alert.
 */
const args = { title: "Code Red", project: "Summer Series", message: "Clear the north lawn." };

for (const [locale, messages] of [
  ["en-US", enUS],
  ["es-US", esUS],
] as const) {
  describe(`a crisis alert in Gateway, ${locale}`, () => {
    const t = createTranslator({ locale, messages: { gateway: messages } }) as unknown as Translate;

    it("reads with its code, project and message", () => {
      const text = fyiSentence(t, { kind: "crisis_alert.issued", args });
      expect(text).toContain("Code Red");
      expect(text).toContain("Summer Series");
      expect(text).toContain("Clear the north lawn.");
    });

    it("reads differently once it has ended", () => {
      const alert = fyiSentence(t, { kind: "crisis_alert.issued", args });
      const ended = fyiSentence(t, {
        kind: "crisis_alert.ended",
        args: { title: args.title, project: args.project },
      });
      expect(ended).toContain("Summer Series");
      expect(ended).not.toEqual(alert);
      expect(ended).not.toContain(alert.split(":")[0]);
    });

    it("leaves other kinds as they were", () => {
      expect(fyiSentence(t, { kind: "something.else", args: { title: "A title" } })).toBe(
        "A title",
      );
    });
  });
}

describe("a blocked vendor", () => {
  it("is sent to Compliance, a tab it has", () => {
    expect(enUS.engagement.overview.blockedCompliance).toContain("Compliance");
    expect(enUS.engagement.overview.blockedCompliance).not.toContain("Onboarding");
    expect(esUS.engagement.overview.blockedCompliance).toContain("Cumplimiento");
    expect(esUS.engagement.overview.blockedCompliance).not.toContain("Incorporación");
  });
});

/**
 * 4.9 surface crawl: notifications Gateway's people receive read with their own arguments, as their emitters store them
 * (private.roster_notification_args, 2642; private.allocation_notification_args, 4693; 6821's dispute decision), never
 * as a bare "New update".
 */
const allocation = {
  personName: "Kai Morgan",
  partyName: "Bayside Audio",
  projectName: "Northwind Summer Series",
  orgName: "Northwind Live",
  kind: "asset",
  itemName: "Two-way radios",
  quantity: "2",
};
const roster = {
  personName: "Demo Staff Two",
  partyName: "Demo Crew Agency",
  projectName: "Northwind Summer Series",
  orgName: "Northwind Live",
};
const sent: readonly [string, Record<string, string>, readonly string[]][] = [
  [
    "roster_entry.declined",
    roster,
    ["Demo Staff Two", "Demo Crew Agency", "Northwind Summer Series"],
  ],
  ["roster_entry.invited", roster, ["Demo Crew Agency", "Northwind Summer Series"]],
  ["allocation.decided", { ...allocation, decision: "declined" }, ["Two-way radios"]],
  ["allocation.assigned", allocation, ["Northwind Live", "Two-way radios"]],
  ["allocation.issued", allocation, ["Two-way radios", "Northwind Summer Series"]],
  ["allocation.withdrawn", { ...allocation, cause: "engagement_ended" }, ["Two-way radios"]],
  [
    "rating_dispute.decided",
    { outcome: "Not Upheld", statement: "On time.", project: "Summer Series" },
    ["Summer Series"],
  ],
];

for (const [locale, messages] of [
  ["en-US", enUS],
  ["es-US", esUS],
] as const) {
  describe(`notifications to external people in Gateway, ${locale}`, () => {
    const t = createTranslator({ locale, messages: { gateway: messages } }) as unknown as Translate;
    const untitled = fyiSentence(t, { kind: "unknown.kind", args: {} });

    it.each(sent)("%s says what happened", (kind, args, names) => {
      const text = fyiSentence(t, { kind, args });
      expect(text).not.toBe(untitled);
      for (const name of names) expect(text).toContain(name);
    });

    it("tells an approved allocation from a declined one, and an upheld dispute from one that was not", () => {
      const decided = (decision: string) =>
        fyiSentence(t, { kind: "allocation.decided", args: { ...allocation, decision } });
      expect(decided("approved")).not.toBe(decided("declined"));
      const dispute = (outcome: string) =>
        fyiSentence(t, {
          kind: "rating_dispute.decided",
          args: { outcome, project: "Summer Series" },
        });
      expect(dispute("Upheld")).not.toBe(dispute("Not Upheld"));
    });
  });
}
