import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import { EXTERNAL_ROLE_TYPES, engagementTabs, formatIssues, validateSitemap } from "@xos/ia";
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
});
