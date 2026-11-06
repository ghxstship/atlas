import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/gateway.json";
import esUS from "../../../packages/i18n/messages/es-US/gateway.json";
import { fyiSentence } from "@/lib/fyi-sentence";
import type { Translate } from "@/lib/shell/translate";

/**
 * Gateway's For Your Information row for a crisis alert (6070): an engaged external person reads it here, so it must carry
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
