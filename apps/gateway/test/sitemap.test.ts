import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import {
  EXTERNAL_ROLE_TYPES,
  VIEW_TYPES,
  engagementTabs,
  flattenRoutes,
  formatIssues,
  getNode,
  validateSitemap,
} from "@xos/ia";
import { loadSitemapFile } from "@xos/ia/node";

const gateway = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));

describe("gateway sitemap", () => {
  it("passes the information architecture validators", () => {
    const issues = validateSitemap(gateway, { messages: getMessages("en-US") });
    expect(formatIssues(issues)).toBe("");
  });

  it.each(EXTERNAL_ROLE_TYPES)("gives %s engagements a tab set (gate 23)", (roleType) => {
    expect(engagementTabs(gateway, roleType).length).toBeGreaterThan(0);
  });

  it("lists views in one order: the default, then the rest in VIEW_TYPES order (A59-029)", () => {
    const misordered = flattenRoutes(gateway).flatMap((r) => {
      const list = getNode(gateway, r.id).node.list;
      if (!list) return [];
      const rest = list.views.filter((v) => v !== list.default);
      const expected = [
        list.default,
        ...[...rest].sort((a, b) => VIEW_TYPES.indexOf(a) - VIEW_TYPES.indexOf(b)),
      ];
      return expected.join(",") === list.views.join(",")
        ? []
        : [`${r.id}: ${list.views.join(", ")} (expected ${expected.join(", ")})`];
    });
    expect(misordered).toEqual([]);
  });
});
