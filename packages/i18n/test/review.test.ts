import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "../src/index.ts";

/**
 * Section 15: a locale becomes general only after a native reviewer signs it off, "recorded in
 * packages/i18n/REVIEW.md". Every shipped locale must have a row there, so a new locale cannot ship without
 * a stated review state.
 */
describe("translation review record", () => {
  const review = readFileSync(new URL("../REVIEW.md", import.meta.url), "utf8");
  const rows = new Map(
    review
      .split("\n")
      .filter((line) => /^\| [a-z]{2}-[A-Z]{2} /.test(line))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return [cells[1] ?? "", cells[3] ?? ""] as const;
      }),
  );

  it.each(locales)("REVIEW.md states the review state of %s", (locale) => {
    expect(rows.get(locale), locale).toBeTruthy();
  });

  it("marks a locale signed off only with a reviewer", () => {
    const signed = review
      .split("\n")
      .filter((line) => /^\| [a-z]{2}-[A-Z]{2} /.test(line) && /Signed off/.test(line));
    for (const line of signed) {
      const reviewer = line.split("|").map((cell) => cell.trim())[4];
      expect(reviewer, line).not.toMatch(/^(None|None yet|n\/a)$/);
    }
  });
});
