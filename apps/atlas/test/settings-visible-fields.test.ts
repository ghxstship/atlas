import { describe, expect, it } from "vitest";
import { pageSettings } from "../lib/settings/registry";
import { splitVisibleFields, VISIBLE_FIELDS } from "../lib/settings/visible-fields";

const field = (key: string, lockedByOrg = false) => ({ key, lockedByOrg });
const keys = (fs: readonly { key: string }[]) => fs.map((f) => f.key);

describe("fields shown before More fields", () => {
  it("shows the first seven when nothing is locked", () => {
    const fields = Array.from({ length: 9 }, (_, i) => field(`f${i}`));
    const { shown, more } = splitVisibleFields(fields);
    expect(keys(shown)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6"]);
    expect(keys(more)).toEqual(["f7", "f8"]);
  });

  it("keeps a value the org locked in view, in registry order, and never shows more than seven", () => {
    const fields = Array.from({ length: 9 }, (_, i) => field(`f${i}`, i === 8));
    const { shown, more } = splitVisibleFields(fields);
    expect(keys(shown)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f8"]);
    expect(keys(more)).toEqual(["f6", "f7"]);
    expect(shown).toHaveLength(VISIBLE_FIELDS);
  });

  it("puts locked values past the seventh under More fields", () => {
    const fields = Array.from({ length: 9 }, (_, i) => field(`f${i}`, true));
    const { shown, more } = splitVisibleFields(fields);
    expect(keys(shown)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6"]);
    expect(keys(more)).toEqual(["f7", "f8"]);
  });

  it("shows a locked time zone on Personal settings > Preferences", () => {
    // The dashboard layouts (A129) sort first, which put the time zone past the seventh field.
    const fields = pageSettings("me.preferences", "personal").map((d) =>
      field(d.key, d.key === "locale.time_zone"),
    );
    expect(fields.length).toBeGreaterThan(VISIBLE_FIELDS);
    expect(keys(splitVisibleFields(fields).shown)).toContain("locale.time_zone");
  });
});
