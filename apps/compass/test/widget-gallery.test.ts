import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMessages, type locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  WIDGET_GALLERY_KEYS,
  WIDGET_GALLERY_LANGUAGES,
  widgetGalleryStrings,
  type Translate,
} from "../src/domain/glance";

// The widget gallery's names and descriptions in every Compass language (A140): WidgetKit shows them before the app
// has run, from the extension's own Localizable.strings, which this test writes from the catalogs.
const target = (path: string) =>
  fileURLToPath(new URL(`../targets/ClockActivity/${path}`, import.meta.url));

function catalog(locale: (typeof locales)[number]): Translate {
  return (key) => {
    const value = key
      .split(".")
      .slice(1)
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        (getMessages(locale) as Record<string, unknown>)["compass"],
      );
    if (typeof value !== "string") throw new Error(`${locale} has no ${key}`);
    return value;
  };
}

describe("widget gallery names and descriptions (A140)", () => {
  const english = catalog("en-US");

  it("names each widget in Swift by its en-US text, which the strings files translate", () => {
    const swift = readFileSync(target("CompassWidgets.swift"), "utf8");
    const named = [
      ...swift.matchAll(/\.(?:configurationDisplayName|description)\("([^"]+)"\)/g),
    ].map((m) => m[1]);
    expect(named).toEqual(WIDGET_GALLERY_KEYS.map((key) => english(key)));
  });

  for (const { lproj, locale } of WIDGET_GALLERY_LANGUAGES) {
    it(`keeps ${lproj}.lproj/Localizable.strings in step with the ${locale} catalog`, () => {
      const path = target(`${lproj}.lproj/Localizable.strings`);
      const expected = widgetGalleryStrings(english, catalog(locale as (typeof locales)[number]));
      if (process.env["XOS_WRITE_GENERATED"] === "1") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, expected);
      }
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      expect(current, "run pnpm --filter @xos/compass generate:widget-strings").toBe(expected);
    });
  }

  it("translates every text, so a Spanish gallery never shows English", () => {
    const spanish = catalog("es-US");
    for (const key of WIDGET_GALLERY_KEYS) expect(spanish(key)).not.toBe(english(key));
    expect(
      widgetGalleryStrings(
        (k) => `a"b\\${k}`,
        () => "x\ny",
      ),
    ).toContain('"a\\"b\\\\');
  });
});
