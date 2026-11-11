import { getMessages, locales } from "@xos/i18n";
import { EXTERNAL_AUDIENCES } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  ATLAS_ONLY_SETTINGS,
  noShiftsKey,
  notificationPromptKeys,
  settingsForAudience,
} from "../src/domain/audienceCopy";
import { sectionSettings } from "../src/settings/preferences";

const message = (locale: (typeof locales)[number], key: string): string =>
  String(
    key
      .split(".")
      .reduce<unknown>(
        (o, part) => (o as Record<string, unknown> | undefined)?.[part],
        getMessages(locale) as unknown,
      ),
  );

describe("C-17: copy fits who is reading it", () => {
  it("never tells an external person to claim open shifts", () => {
    expect(noShiftsKey("field")).toBe("compass.today.noShifts");
    for (const audience of EXTERNAL_AUDIENCES) {
      expect(noShiftsKey(audience)).toBe("compass.today.noShiftsExternal");
    }
    for (const locale of locales) {
      expect(message(locale, "compass.today.noShiftsExternal")).not.toMatch(
        /open shift|turnos abiertos/i,
      );
    }
  });

  it("offers approving from the alert only to a timesheet approver", () => {
    expect(notificationPromptKeys(true).prompt).toBe("compass.notifications.prompt");
    const general = notificationPromptKeys(false);
    for (const locale of locales) {
      for (const key of [general.title, general.prompt, general.denied]) {
        expect(message(locale, key), `${locale} ${key}`).not.toMatch(
          /timesheet|hojas de horas|approve|aprobar/i,
        );
      }
    }
  });

  it("leaves Atlas's own settings out of an external person's Preferences", () => {
    const preferences = sectionSettings("settings.preferences");
    expect(preferences.some((d) => ATLAS_ONLY_SETTINGS.has(d.key))).toBe(true);
    const shown = settingsForAudience(preferences, "vendor").map((d) => d.key);
    for (const key of ATLAS_ONLY_SETTINGS) expect(shown).not.toContain(key);
    expect(settingsForAudience(preferences, "field").map((d) => d.key)).toEqual(
      preferences.map((d) => d.key),
    );
  });

  it("speaks of no delegate or org directory to an external person", () => {
    for (const section of ["settings.out-of-office", "settings.work-details"] as const) {
      for (const audience of EXTERNAL_AUDIENCES) {
        for (const def of settingsForAudience(sectionSettings(section), audience)) {
          if (!def.help) continue;
          for (const locale of locales) {
            expect(message(locale, def.help), `${audience} ${def.key} ${locale}`).not.toMatch(
              /delegate|org directory|delegad|en el directorio/i,
            );
          }
        }
      }
    }
  });
});
