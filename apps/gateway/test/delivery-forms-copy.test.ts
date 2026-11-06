import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/gateway.json";
import esUS from "../../../packages/i18n/messages/es-US/gateway.json";

/**
 * The delivery forms (B11, G-115) read their labels under gateway.engagement.deliveries.book and their field errors under
 * gateway.engagement.forms.errors. A key outside those renders as a raw path on the vendor's booking form.
 */
const source = readFileSync(
  new URL("../components/engagement/delivery-forms.tsx", import.meta.url),
  "utf8",
);
const actions = readFileSync(new URL("../lib/actions/deliveries.ts", import.meta.url), "utf8");

describe("delivery forms copy", () => {
  const keys = [...source.matchAll(/\bt\("([a-zA-Z.]+)"\)/g)].map((m) => m[1] ?? "");
  const errors = [...actions.matchAll(/fieldError: "([a-zA-Z]+)"/g)].map((m) => m[1] ?? "");

  it("finds what it checks", () => {
    expect(keys.length).toBeGreaterThan(5);
    expect(errors.length).toBeGreaterThan(0);
  });

  for (const [locale, catalog] of [
    ["en-US", enUS],
    ["es-US", esUS],
  ] as const) {
    it(`names only keys ${locale} holds`, () => {
      const book = catalog.engagement.deliveries.book as Record<string, unknown>;
      const fieldErrors = catalog.engagement.forms.errors as Record<string, unknown>;
      expect(keys.filter((k) => typeof book[k] !== "string")).toEqual([]);
      expect(errors.filter((k) => typeof fieldErrors[k] !== "string")).toEqual([]);
    });
  }
});
