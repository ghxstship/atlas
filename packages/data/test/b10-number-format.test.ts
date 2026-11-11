import { describe, expect, it } from "vitest";
import { numberFormatOfLocale } from "../src/pool-invitations.ts";

describe("the number format of an org's language (B10)", () => {
  it("derives the separators from Intl, and comma-dot for anything else", () => {
    expect(numberFormatOfLocale("en-US")).toBe("comma-dot");
    expect(numberFormatOfLocale("es-US")).toBe("comma-dot");
    expect(numberFormatOfLocale("de-DE")).toBe("dot-comma");
    expect(numberFormatOfLocale("fr-FR")).toBe("space-comma");
    expect(numberFormatOfLocale("de-CH")).toBe("apostrophe-dot");
    expect(numberFormatOfLocale("ja-JP")).toBe("comma-dot");
  });
});
