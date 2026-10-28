import { describe, expect, it } from "vitest";
import {
  chromeSlot,
  CONSOLE_OPERATOR_ROLES,
  flattenRoutes,
  formatIssues,
  isNodeVisible,
  validateSitemap,
} from "../src/index.ts";
import { loadApp, messages } from "./support.ts";

const operatorConsole = loadApp("console");

/**
 * The operator console sitemap (A90, RRR-135; Section 4.10, Section 6): valid like the other shells, keyed by the
 * operator roles of migration 1470, with support sessions hidden from Trust and Safety, the moderation queue hidden
 * from Support and the platform team roster for Administrators only. The database checks each action again.
 */
describe("console sitemap", () => {
  it("passes every sitemap rule", () => {
    expect(formatIssues(validateSitemap(operatorConsole, { messages }))).toBe("");
  });

  it("is keyed by the operator roles and starts at tenant search", () => {
    expect(operatorConsole.audience.roles).toEqual([...CONSOLE_OPERATOR_ROLES]);
    expect(operatorConsole.home).toBe("tenants");
  });

  it("routes every console page", () => {
    expect(flattenRoutes(operatorConsole).map((r) => r.route)).toEqual([
      "/tenants",
      "/tenants/{orgId}",
      "/flags",
      "/support",
      "/support/{sessionId}",
      "/moderation",
      "/moderation/{opportunityId}",
      "/banners",
      "/funnels",
      "/team",
      "/activity",
    ]);
  });

  it("shows each role only the pages its permissions use", () => {
    const visible = (role: string) =>
      chromeSlot(operatorConsole, "topBar", { role }).map((n) => n.id);
    expect(visible("administrator")).toEqual([
      "tenants",
      "flags",
      "support",
      "moderation",
      "banners",
      "funnels",
      "team",
      "activity",
    ]);
    expect(visible("support")).toEqual([
      "tenants",
      "flags",
      "support",
      "banners",
      "funnels",
      "activity",
    ]);
    expect(visible("trust-and-safety")).toEqual([
      "tenants",
      "flags",
      "moderation",
      "banners",
      "funnels",
      "activity",
    ]);
    expect(isNodeVisible(operatorConsole, "moderation.listing", { role: "support" })).toBe(false);
    expect(isNodeVisible(operatorConsole, "support.session", { role: "trust-and-safety" })).toBe(
      false,
    );
  });
});
