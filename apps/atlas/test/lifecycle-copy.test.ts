import type { OrgBannerStatus } from "@xos/data/org-lifecycle";
import { describe, expect, it } from "vitest";
import enShell from "../../../packages/i18n/messages/en-US/shell.json";
import esShell from "../../../packages/i18n/messages/es-US/shell.json";
import { planLimitBannersApply } from "@/lib/shell/org-read-only";

/**
 * Lifecycle copy that contradicted the state (crawl 4.9): Danger Zone's lead offered to archive the org, which no action
 * does; a canceled org showed the read-only banner and, beside it, plan-limit advice to upgrade. (Billing's "2 of 1
 * seats in use" is covered in billing-current-subscription.test.ts.)
 */
const status = (readOnlyReason: OrgBannerStatus["readOnlyReason"]) =>
  ({ readOnlyReason }) as OrgBannerStatus;

describe("lifecycle copy", () => {
  it("offers no archive in Danger Zone's lead, and names cancel", () => {
    expect(enShell.pages.settings.dangerZone.empty).not.toMatch(/archive/i);
    expect(enShell.pages.settings.dangerZone.empty).toMatch(/Cancel/);
    expect(esShell.pages.settings.dangerZone.empty).not.toMatch(/archiva/i);
    expect(esShell.pages.settings.dangerZone.empty).toMatch(/Cancela/);
  });

  it("shows no plan-limit advice in a canceled org or one waiting for deletion", () => {
    expect(planLimitBannersApply(status("canceled"))).toBe(false);
    expect(planLimitBannersApply(status("deletion"))).toBe(false);
    for (const reason of [null, "dunning", "paused"] as const) {
      expect(planLimitBannersApply(status(reason))).toBe(true);
    }
  });
});
