import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Intl.DateTimeFormat refuses dateStyle or timeStyle together with timeZoneName ("Invalid option"), and the page
 * that builds such a formatter answers 500 (the 4.11 settings audit and support panels). This keeps that pairing out
 * of every formatter the apps and packages build, through Intl.DateTimeFormat or next-intl's format.dateTime.
 */
const root = join(import.meta.dirname, "..", "..", "..");
const SCANNED = ["apps", "packages"];
const SKIP = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "_vendor",
  "test",
  "e2e",
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(path);
  }
  return out;
}

/** The options of each formatter call: the text from the call to its first closing brace. */
export function badFormatterOptions(source: string): string[] {
  const bad: string[] = [];
  for (const match of source.matchAll(/(?:DateTimeFormat|\.dateTime)\(/g)) {
    const rest = source.slice(match.index, match.index + 600);
    const end = rest.indexOf("}");
    const options = end === -1 ? rest : rest.slice(0, end);
    if (/\b(dateStyle|timeStyle)\s*:/.test(options) && /\btimeZoneName\s*:/.test(options))
      bad.push(options.split("\n")[0] ?? "");
  }
  return bad;
}

describe("date and time formatter options", () => {
  it("finds the pairing Intl refuses", () => {
    expect(
      badFormatterOptions(
        'new Intl.DateTimeFormat(locale, {\n  dateStyle: "medium",\n  timeZone: zone,\n  timeZoneName: "short",\n});',
      ),
    ).toHaveLength(1);
    expect(
      badFormatterOptions(
        'new Intl.DateTimeFormat(locale, { month: "short", hour: "numeric", timeZoneName: "short" });',
      ),
    ).toEqual([]);
    expect(
      () => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZoneName: "short" }),
    ).toThrow();
  });

  it("never pairs dateStyle or timeStyle with timeZoneName in the apps and packages", () => {
    const found = SCANNED.flatMap((top) => sources(join(root, top))).flatMap((file) =>
      badFormatterOptions(readFileSync(file, "utf8")).map(
        (call) => `${relative(root, file)}: ${call}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
