import { getMessages } from "@xos/i18n";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { applyLanguage, deviceLocale, initI18n } from "../src/runtime/i18n";

/**
 * Compass renders in locale.language as resolved for the person (CompassProvider applies languageOf of the
 * resolved values), and in the device's language when nobody chose one (A65-001). i18next starts with the
 * device's catalog and en-US only, so a chosen language brings its own catalog with it, a Beta one included
 * (ADR 0053).
 */
const KEY = "compass.signIn.identitySteps.access";
const esUS = (
  getMessages("es-US") as { compass: { signIn: { identitySteps: { access: string } } } }
).compass.signIn.identitySteps.access;
const enUS = (
  getMessages("en-US") as { compass: { signIn: { identitySteps: { access: string } } } }
).compass.signIn.identitySteps.access;

describe("the language Compass renders in", () => {
  it("switches to a chosen language it did not start with, and back to the device's", async () => {
    initI18n("en-US");
    expect(i18next.hasResourceBundle("es-US", "translation")).toBe(false);
    await applyLanguage("es-US");
    expect(i18next.language).toBe("es-US");
    expect(esUS).not.toBe(enUS);
    expect(i18next.t(KEY)).toBe(esUS);
    await applyLanguage(null);
    expect(i18next.language).toBe(deviceLocale());
  });

  it("loads a chosen Beta language, whose missing keys read en-US", async () => {
    initI18n("en-US");
    await applyLanguage("fr-FR");
    expect(i18next.language).toBe("fr-FR");
    expect(i18next.hasResourceBundle("fr-FR", "translation")).toBe(true);
    expect(i18next.t(KEY)).toBe(enUS);
    await applyLanguage(null);
  });

  it("ends on the latest choice when an earlier one is still loading", async () => {
    initI18n("en-US");
    const loading = applyLanguage("de-DE");
    await applyLanguage("es-US");
    await loading;
    expect(i18next.language).toBe("es-US");
    await applyLanguage(null);
    expect(i18next.language).toBe(deviceLocale());
  });
});
