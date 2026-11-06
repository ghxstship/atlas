import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFormsThatLoseInput } from "../../../packages/testing/src/form-audit.ts";
import { describe, expect, it } from "vitest";

/**
 * B3 (RRR-227, ADR 0142): every form of the package keeps what was typed and never does a native GET. A form with
 * onSubmit only and no action does a GET when clicked before hydration, with the fields in the URL; on the portal that
 * URL holds the token's path, so cue text would land in access logs. The code form posts natively to a URL and is the
 * one exception.
 */
const here = dirname(fileURLToPath(import.meta.url));
const show = (file: string) => join(here, "..", "components", "show", file);
const FORMS = [
  "cue-form-tabs.tsx",
  "show-channel-panel.tsx",
  "segment-library.tsx",
  "showcaller-link-dialog.tsx",
  "showcaller-portal.tsx",
];

/** Each `<form ...>` opening tag in a source, skipping `>` inside braces. */
function openingTags(source: string): string[] {
  return [...source.matchAll(/<form\b/g)].map((match) => {
    let depth = 0;
    for (let i = match.index; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) return source.slice(match.index, i + 1);
    }
    return source.slice(match.index);
  });
}

describe("B3's forms", () => {
  it.each(FORMS)("%s has at least one form", (file) => {
    expect(openingTags(readFileSync(show(file), "utf8")).length).toBeGreaterThan(0);
  });

  it.each(FORMS)("%s keeps its input on a refusal", (file) => {
    expect(findFormsThatLoseInput(file, readFileSync(show(file), "utf8"))).toEqual([]);
  });

  it.each(FORMS)("%s keeps an action beside onSubmit on every form", (file) => {
    for (const tag of openingTags(readFileSync(show(file), "utf8"))) {
      expect(tag).toMatch(/\baction=\{/);
      expect(tag).toMatch(/\bonSubmit=\{/);
    }
  });

  it("leaves the code form its native post to a URL", () => {
    const [tag] = openingTags(readFileSync(show("showcaller-code-form.tsx"), "utf8"));
    expect(tag).toMatch(/\baction=\{/);
    expect(tag).toMatch(/\bmethod="post"/i);
    expect(tag).not.toMatch(/\bonSubmit=\{/);
  });
});
