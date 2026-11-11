import { readFileSync } from "node:fs";
import type { OrgBannerStatus } from "@xos/data/org-lifecycle";
import { describe, expect, it } from "vitest";
import enProjects from "../../../packages/i18n/messages/en-US/projects.json";
import esProjects from "../../../packages/i18n/messages/es-US/projects.json";
import { orgReadOnly } from "@/lib/shell/org-read-only";

/**
 * A canceled org still offered New project to a Manager, then refused with "The change was refused (org_read_only).
 * Review the project and try again." (crawl 4.9). A read-only org now offers no create action, and the refusal, if met
 * anyway, reads in words.
 */
const status = (readOnlyReason: OrgBannerStatus["readOnlyReason"]) =>
  ({ ok: true, data: { readOnlyReason } as OrgBannerStatus }) as const;

describe("orgReadOnly", () => {
  it("is true for every whole-org read-only reason", () => {
    for (const reason of ["canceled", "deletion", "dunning", "paused"] as const) {
      expect(orgReadOnly(status(reason))).toBe(true);
    }
  });

  it("is false for a writable org or an unreadable status", () => {
    expect(orgReadOnly(status(null))).toBe(false);
    expect(orgReadOnly({ ok: false, error: { kind: "not-found" } })).toBe(false);
  });
});

describe("the org_read_only refusal on Projects", () => {
  it("is a known refusal with its own copy, never the raw code", () => {
    const actions = readFileSync(new URL("../lib/projects/actions.ts", import.meta.url), "utf8");
    const known = actions.slice(actions.indexOf("const KNOWN_REFUSALS"), actions.indexOf("]);"));
    expect(known).toContain('"org_read_only"');
    for (const copy of [enProjects.errors.org_read_only, esProjects.errors.org_read_only]) {
      expect(copy).toBeTruthy();
      expect(copy).not.toContain("org_read_only");
    }
  });
});
