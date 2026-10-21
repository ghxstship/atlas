import i18next from "i18next";
import { describe, expect, it, vi } from "vitest";
import { applyLanguage, deviceLocale, initI18n } from "../src/runtime/i18n";

/**
 * Compass renders in locale.language as resolved for the person (CompassProvider applies languageOf of the
 * resolved values), and in the device's language when nobody chose one (A65-001).
 */
describe("the language Compass renders in", () => {
  it("switches to the chosen language and back to the device's", async () => {
    initI18n("en-US");
    await vi.waitFor(() => expect(i18next.language).toBe("en-US"));
    applyLanguage("es-US");
    await vi.waitFor(() => expect(i18next.language).toBe("es-US"));
    expect(i18next.t("compass.signIn.identitySteps.access")).toBe(
      i18next.getResource("es-US", "translation", "compass.signIn.identitySteps.access"),
    );
    applyLanguage(null);
    await vi.waitFor(() => expect(i18next.language).toBe(deviceLocale()));
  });
});
