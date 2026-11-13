import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/activity.json";
import esUS from "../../../packages/i18n/messages/es-US/activity.json";
import {
  auditActionText,
  auditActorText,
  auditDetailText,
  singularTable,
  tableWords,
} from "@/lib/activity-audit";

/**
 * Crawl 4.9: the settings audit panel, Trash and the legal-hold picker showed raw identifiers
 * (legal_acceptances.insert, onboarding_requirements), and a platform support read showed as an insert by "A person"
 * or "Redacted" with "1 field: new". Each now reads in words: the action, who made it (the platform support team for
 * support reads, whose operators row level security hides from the org) and the area the read opened.
 */
type T = Parameters<typeof auditActionText>[2];

function activityT(locale: "en-US" | "es-US"): T {
  const t = createTranslator({ locale, messages: { activity: locale === "en-US" ? enUS : esUS } });
  return Object.assign(
    (key: string, values?: Record<string, string | number>) =>
      (t as unknown as (k: string, v?: Record<string, string | number>) => string)(
        `activity.${key}`,
        values,
      ),
    { has: (key: string) => t.has(`activity.${key}` as never) },
  );
}

const supportRead = {
  action: "support_session_accesses.insert",
  actor: null,
  actorKind: "Person",
  subjectTable: "app.support_session_accesses",
  diff: { new: { area: "Members", operator_person_id: "p-1" } },
  redacted: false,
};

describe("table names in words", () => {
  it("reads a table without its schema or underscores", () => {
    expect(tableWords("app.onboarding_requirements")).toBe("Onboarding requirements");
    expect(tableWords("projects")).toBe("Projects");
  });
});

for (const locale of ["en-US", "es-US"] as const) {
  describe(`audit entries in ${locale}`, () => {
    const t = activityT(locale);

    it("names a platform support read's actor and the area it opened", () => {
      const actor = auditActorText(supportRead, t);
      expect(actor).toBe(t("audit.platformTeam"));
      expect(actor).not.toBe(t("audit.redacted"));
      const detail = auditDetailText(supportRead, t);
      expect(detail).toContain(t("audit.areas.Members"));
      expect(detail).not.toMatch(/\bnew\b/);
    });

    it("reads legal acceptances and support sessions with catalog nouns", () => {
      for (const table of ["app.legal_acceptances", "app.support_sessions", "app.verbiage_terms"]) {
        const text = auditActionText(`${table.slice(4)}.insert`, table, t);
        expect(text).not.toContain("_");
        expect(t.has(`subjects.${singularTable(table)}`)).toBe(true);
        expect(text).toContain(t(`subjects.${singularTable(table)}`));
      }
    });

    it("keeps a member's name, and says a person without one", () => {
      expect(auditActorText({ ...supportRead, actor: "Ada" }, t)).toBe("Ada");
      const plain = { ...supportRead, subjectTable: "app.projects" };
      expect(auditActorText(plain, t)).toBe(t("audit.person"));
      expect(auditActorText({ ...plain, redacted: true }, t)).toBe(t("audit.redacted"));
    });

    it("lists the fields of any other change", () => {
      const update = {
        subjectTable: "app.projects",
        diff: { name: "x", key: "y" },
        redacted: false,
      };
      expect(auditDetailText(update, t)).toContain("name, key");
    });
  });
}
