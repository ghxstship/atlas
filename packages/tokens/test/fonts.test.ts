import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dtcgLeaves, readJson } from "./source.ts";

interface FontFamily {
  token: string;
  family: string;
  alsoNamed: string[];
  weights: number[];
  style: string;
  license: string;
  licenseFile: string;
  files: { variable: string[]; static: string[] };
}

const { families } = readJson<{ families: FontFamily[] }>("fonts.json");
const base = dtcgLeaves(readJson("tokens/base.tokens.json"));
const guide = readFileSync(fileURLToPath(new URL("../FONTS.md", import.meta.url)), "utf8");

/** The named families of a font-family value, in order, without the generic and system keywords. */
function named(value: unknown): string[] {
  return String(value)
    .split(",")
    .map((name) => name.trim().replace(/^"(.*)"$/, "$1"));
}

describe("fonts.json states the fonts a consumer serves (issue 110)", () => {
  it("lists every font family token", () => {
    const tokens = [...base.keys()].filter((name) => name.startsWith("font.family."));
    expect(families.map((f) => f.token).sort()).toEqual(tokens.sort());
  });

  it.each(families.map((f) => [f.family, f] as const))(
    "%s leads its token's family list",
    (_name, font) => {
      const list = named(base.get(font.token)?.$value);
      expect(list.slice(0, 1 + font.alsoNamed.length)).toEqual([font.family, ...font.alsoNamed]);
    },
  );

  it("asks for no weight the tokens do not define", () => {
    const weights = [...base.entries()]
      .filter(([name]) => name.startsWith("font.weight."))
      .map(([, leaf]) => Number(leaf.$value));
    const sans = families.find((f) => f.token === "font.family.sans");
    expect(sans?.weights).toEqual(weights.sort((a, b) => a - b));
    for (const font of families) {
      for (const weight of font.weights) expect(weights).toContain(weight);
    }
  });

  it("names a file for every weight, and only fonts a site may host", () => {
    for (const font of families) {
      expect(font.license).toBe("OFL-1.1");
      expect(font.style).toBe("normal");
      if (font.files.variable.length === 0)
        expect(font.files.static).toHaveLength(font.weights.length);
      for (const file of [...font.files.variable, ...font.files.static]) {
        expect(file).toMatch(/^[A-Za-z-]+\.woff2$/);
      }
    }
  });

  it("FONTS.md states the same families, weights and files", () => {
    for (const font of families) {
      expect(guide).toMatch(new RegExp(`\\| ${font.family} +\\| \`${font.token}\``));
      expect(guide).toContain(font.weights.join(", "));
      for (const file of [...font.files.variable, ...font.files.static]) {
        expect(guide).toContain(`\`${file}\``);
      }
    }
    expect(guide).not.toMatch(/https?:\/\//);
  });

  it("FONTS.md names the license file each release carries, which differs by project", () => {
    // Inter's release holds the OFL text as LICENSE.txt and has no OFL.txt; JetBrains Mono's holds OFL.txt.
    expect(Object.fromEntries(families.map((f) => [f.family, f.licenseFile]))).toEqual({
      Inter: "LICENSE.txt",
      "JetBrains Mono": "OFL.txt",
    });
    for (const font of families) {
      expect(guide).toContain(`\`${font.licenseFile}\` for ${font.family}`);
    }
    expect(guide).not.toMatch(/keep its `OFL\.txt`/);
  });
});
