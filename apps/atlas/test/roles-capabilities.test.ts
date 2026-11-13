import { describe, expect, it } from "vitest";
import enShell from "../../../packages/i18n/messages/en-US/shell.json";
import esShell from "../../../packages/i18n/messages/es-US/shell.json";
import enSettings from "../../../packages/i18n/messages/en-US/settings.json";
import esSettings from "../../../packages/i18n/messages/es-US/settings.json";
import { capabilitiesByModule } from "@/lib/settings/role-capabilities";

/**
 * Roles and Capabilities (crawl 4.9) promised "Build custom roles from the capability set" with no way to build one
 * or see a role's capabilities. The page now says what it shows, and lists each role's capabilities by area.
 */
const ROLES = ["owner", "admin", "manager", "member", "collaborator", "field", "viewer"];

describe("Roles and Capabilities", () => {
  it("groups a role's capabilities by area, sorted", () => {
    const groups = capabilitiesByModule(
      new Map([
        ["projects.project.write", "assigned"],
        ["finance.invoice.read", "organization"],
        ["projects.project.read", "organization"],
      ]),
    );
    expect(groups.map((g) => g.group)).toEqual(["finance", "projects"]);
    expect(groups[1]?.capabilities.map(([code]) => code)).toEqual([
      "projects.project.read",
      "projects.project.write",
    ]);
  });

  for (const [locale, shell, settings] of [
    ["en-US", enShell, enSettings],
    ["es-US", esShell, esSettings],
  ] as const) {
    it(`promises no custom-role builder in ${locale}, and describes every platform role`, () => {
      const lead = shell.pages.settings.rolesAndCapabilities.empty;
      expect(lead).not.toMatch(/build custom roles|crea roles personalizados/i);
      for (const role of ROLES) {
        expect(
          settings.roles.descriptions[role as keyof typeof settings.roles.descriptions],
        ).toBeTruthy();
      }
      expect(Object.keys(settings.roles.reach).sort()).toEqual(["assigned", "organization", "own"]);
    });
  }
});
