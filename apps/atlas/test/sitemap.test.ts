import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import { formatIssues, MAX_DEPTH, validateServedBy, validateSitemap } from "@xos/ia";
import { loadSitemapFile } from "@xos/ia/node";

const atlas = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));
const gateway = loadSitemapFile(new URL("../../gateway/ia/sitemap.yaml", import.meta.url));

describe("atlas sitemap", () => {
  it("passes the information architecture validators", () => {
    const issues = validateSitemap(atlas, { messages: getMessages("en-US") });
    expect(formatIssues(issues)).toBe("");
  });

  it("points its token routes at routes Gateway serves", () => {
    expect(formatIssues(validateServedBy(atlas, [gateway]))).toBe("");
  });

  it("is the Atlas sitemap with the depth limit of gate 25", () => {
    expect(atlas.shell).toBe("atlas");
    expect(MAX_DEPTH).toBe(3);
  });
});
