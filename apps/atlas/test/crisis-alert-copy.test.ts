import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/incidents.json";
import esUS from "../../../packages/i18n/messages/es-US/incidents.json";

/**
 * What Atlas says after a crisis alert (launch flag, 2026-11-06): how many people were told, honestly when that is nobody,
 * and never that emergency services were contacted.
 */
for (const [locale, messages, emergency] of [
  ["en-US", enUS, "XOS does not contact emergency services."],
  ["es-US", esUS, "XOS no contacta a los servicios de emergencia."],
] as const) {
  describe(`crisis alert confirmation in ${locale}`, () => {
    const t = createTranslator({ locale, messages: { incidents: messages } });

    it("states how many were told and how many were clocked in", () => {
      const many = t("incidents.alerts.issued", { count: 12, onSite: "5" });
      expect(many).toContain("12");
      expect(many).toContain("5");
      expect(many).toContain(emergency);
      expect(t("incidents.alerts.issued", { count: 1, onSite: "0" })).toContain("1 ");
      expect(t("incidents.alerts.reach", { count: 12, onSite: 5 })).toContain("12");
    });

    it("says so when nobody could be told, and what to do instead", () => {
      const nobody = t("incidents.alerts.issued", { count: 0, onSite: "0" });
      expect(nobody).not.toContain("0 ");
      expect(nobody).toMatch(/radio/);
      expect(nobody).toContain(emergency);
      expect(t("incidents.alerts.reach", { count: 0, onSite: 0 })).toMatch(/radio/);
    });

    it("never says emergency services were contacted", () => {
      for (const count of [0, 1, 12]) {
        expect(t("incidents.alerts.issued", { count, onSite: "0" })).toContain(emergency);
      }
      expect(t("incidents.alerts.reachHelp")).toMatch(/emerg/i);
    });
  });
}
