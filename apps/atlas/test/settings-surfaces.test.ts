import { describe, expect, it } from "vitest";
import { isNodeVisible } from "@xos/ia";
import { membershipConditions, PERSONAL_TOKENS_SETTING } from "../lib/shell/membership";
import { sitemap } from "../ia/sitemap.generated";

/**
 * Settings surfaces (A86, RRR-131, finding A65-004).
 */

describe("developer.personal_tokens decides whether Personal settings, Developer exists", () => {
  it("names the registered setting", () => {
    expect(PERSONAL_TOKENS_SETTING).toBe("developer.personal_tokens");
  });

  it("adds the org-allows-personal-tokens condition only while the org allows tokens", () => {
    const off = membershipConditions({ desktop: true, partner: false, personalTokens: false });
    const on = membershipConditions({ desktop: true, partner: false, personalTokens: true });
    expect(off).toEqual(["desktop"]);
    expect(on).toEqual(["desktop", "org-allows-personal-tokens"]);
    const nav = (conditions: typeof on) => ({ role: "member" as const, conditions });
    expect(isNodeVisible(sitemap, "me.developer", nav(off))).toBe(false);
    expect(isNodeVisible(sitemap, "me.developer", nav(on))).toBe(true);
  });
});
