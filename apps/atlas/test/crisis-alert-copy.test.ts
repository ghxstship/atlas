import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/incidents.json";
import esUS from "../../../packages/i18n/messages/es-US/incidents.json";
import { alertReach } from "@/lib/incidents/alert-reach";

/**
 * What Atlas says after a crisis alert (launch flag, 2026-11-06): how many people were told, honestly when that is nobody
 * or not everyone yet, and never that emergency services were contacted.
 */
for (const [locale, messages, emergency, later, text] of [
  ["en-US", enUS, "XOS does not contact emergency services.", /email can take longer/, /text/],
  [
    "es-US",
    esUS,
    "XOS no contacta a los servicios de emergencia.",
    /correo puede tardar más/,
    /texto/,
  ],
] as const) {
  describe(`crisis alert confirmation in ${locale}`, () => {
    const t = createTranslator({ locale, messages: { incidents: messages } });

    it("states how many were told and how many were clocked in", () => {
      const many = t("incidents.alerts.issued", { count: 12, onSite: "5", waiting: 0 });
      expect(many).toContain("12");
      expect(many).toContain("5");
      expect(many).toContain(emergency);
      expect(t("incidents.alerts.issued", { count: 1, onSite: "0", waiting: 0 })).toContain("1 ");
      expect(t("incidents.alerts.reach", { count: 12, onSite: 5 })).toContain("12");
    });

    it("does not say a phone has it when the worker is still sending", () => {
      // The Inbox has it as the alert is written; push, text and email leave from the delivery worker.
      expect(t("incidents.alerts.issued", { count: 1005, onSite: "400", waiting: 0 })).toMatch(
        later,
      );
      expect(t("incidents.alerts.reachHelp")).toMatch(later);
      expect(t("incidents.alerts.reachHelp")).toMatch(text);
    });

    it("says so when nobody could be told, and what to do instead", () => {
      const nobody = t("incidents.alerts.issued", { count: 0, onSite: "0", waiting: 0 });
      expect(nobody).not.toContain("0 ");
      expect(nobody).toMatch(/radio/);
      expect(nobody).toContain(emergency);
      // Zero has several causes (nobody there, everyone's channels off, someone who left), so it names none.
      expect(nobody).not.toMatch(/clocked in|assigned|entrada marcada|asignad/);
      expect(t("incidents.alerts.reach", { count: 0, onSite: 0 })).toMatch(/radio/);
    });

    it("says who is still being told when an alert is too large for one statement", () => {
      const partial = t("incidents.alerts.issued", { count: 1700, onSite: "20", waiting: 3300 });
      expect(partial).toMatch(/1[,.]?700/);
      expect(partial).toMatch(/3[,.]?300/);
      expect(partial).toMatch(/radio/);
      expect(partial).toContain(emergency);
      const none = t("incidents.alerts.issued", { count: 0, onSite: "0", waiting: 5000 });
      expect(none).toMatch(/5[,.]?000/);
      expect(none).not.toMatch(/nobody|nadie/i);
    });

    const copy = (key: string, values: Record<string, number>) =>
      t(key as "incidents.alerts.reach", values as { count: number; onSite: number });
    const row = {
      peopleTold: 1700,
      peopleToldOnSite: 20,
      peopleWaiting: 0,
      peopleNotSent: 0,
    };

    it("says on the alert's row what it reached", () => {
      expect(alertReach(copy, row)).toMatch(/1[,.]?700/);
      const waiting = alertReach(copy, { ...row, peopleWaiting: 3300 });
      expect(waiting).toMatch(/3[,.]?300/);
      // Zero with people still waiting is not "could not reach anyone".
      expect(alertReach(copy, { ...row, peopleTold: 0, peopleWaiting: 3300 })).not.toMatch(/radio/);
      const failed = alertReach(copy, { ...row, peopleNotSent: 2 });
      expect(failed).toMatch(/2/);
      expect(failed).toMatch(/radio/);
    });

    it("never says emergency services were contacted", () => {
      for (const count of [0, 1, 12]) {
        for (const waiting of [0, 3]) {
          expect(t("incidents.alerts.issued", { count, onSite: "0", waiting })).toContain(
            emergency,
          );
        }
      }
      expect(t("incidents.alerts.reachHelp")).toMatch(/emerg/i);
    });
  });
}
