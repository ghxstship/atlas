import { describe, expect, it } from "vitest";
import en from "../../../packages/i18n/messages/en-US/settingsSurfaces.json";
import es from "../../../packages/i18n/messages/es-US/settingsSurfaces.json";
import { personalTokensState } from "@/lib/settings/plan";

/**
 * On the Access plan the org's personal-token panel said "Turn on Allow personal API tokens above" while the setting
 * was already on (crawl 4.9): app.org_allows_personal_tokens is false when the plan has no api_keys, and the panel
 * read every false as the setting. The plan now has its own sentence.
 */
describe("personalTokensState", () => {
  it("names the plan, not the setting, when the plan has no API access", () => {
    expect(personalTokensState(false, false)).toBe("orgPlanOff");
    expect(personalTokensState(false, true)).toBe("orgOff");
    expect(personalTokensState(true, true)).toBe("orgOn");
  });

  it("has copy in both languages that never asks to turn the setting on", () => {
    for (const copy of [en.tokens.orgPlanOff, es.tokens.orgPlanOff]) {
      expect(copy).toBeTruthy();
      expect(copy).not.toMatch(/turn on|active permitir/i);
    }
  });
});
