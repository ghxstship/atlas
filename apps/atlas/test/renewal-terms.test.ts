import { createHash } from "node:crypto";
import { getMessages } from "@xos/i18n";
import { CHECKOUT_MESSAGE_MAX, RENEWAL_TERMS_VERSION } from "@xos/platform/billing";
import { describe, expect, it } from "vitest";

/**
 * The renewal terms an Owner agrees to are evidence (ADR 0161, migration 6141): each consent records the wording's version.
 * This test pins the wording to that version, so changing the copy without bumping RENEWAL_TERMS_VERSION fails, and it holds
 * the statement inside Stripe's limit, in both languages.
 */
const PINNED = {
  version: "2026-11-06",
  sha256: "b65cbbe17d7e822bdd7deeccb4ed0e68bafbee0ca13580b2a36fb162fbb6eecf",
};

function renewal(locale: "en-US" | "es-US") {
  const messages = getMessages(locale) as unknown as {
    shell: { settings: { billing: { renewal: Record<string, unknown> } } };
  };
  return messages.shell.settings.billing.renewal as {
    statementMonthly: string;
    statementAnnual: string;
    agree: string;
  };
}

describe("the renewal terms", () => {
  it("cannot change without a new version", () => {
    const wording = (["en-US", "es-US"] as const).flatMap((locale) => {
      const r = renewal(locale);
      return [r.statementMonthly, r.statementAnnual, r.agree];
    });
    const sha256 = createHash("sha256").update(JSON.stringify(wording)).digest("hex");
    expect({ version: RENEWAL_TERMS_VERSION, sha256 }).toEqual(PINNED);
  });

  it("fit Stripe's limit with room for a long plan name, price and date", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      const r = renewal(locale);
      for (const statement of [r.statementMonthly, r.statementAnnual]) {
        expect(statement.length + 60).toBeLessThanOrEqual(CHECKOUT_MESSAGE_MAX);
      }
    }
  });

  it("state the price, the term, the first charge and how to cancel, in both languages", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      const r = renewal(locale);
      for (const statement of [r.statementMonthly, r.statementAnnual]) {
        for (const field of ["{plan}", "{price}", "{date}"]) expect(statement).toContain(field);
      }
    }
    expect(renewal("en-US").statementMonthly).toContain("End plan");
    expect(renewal("es-US").statementMonthly).toContain("Terminar plan");
    expect(renewal("en-US").statementAnnual).toContain("30 days before each renewal");
    expect(renewal("es-US").statementAnnual).toContain("30 días antes de cada renovación");
  });
});
