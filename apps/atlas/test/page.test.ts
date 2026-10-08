import { describe, expect, it } from "vitest";
import { getMessages, locales } from "@xos/i18n";

describe("atlas shell copy", () => {
  it.each(locales)("has a name and tagline in %s", (locale) => {
    const shell = getMessages(locale).shell.atlas;
    expect(shell.name.length).toBeGreaterThan(0);
    expect(shell.tagline.length).toBeGreaterThan(0);
  });
});
