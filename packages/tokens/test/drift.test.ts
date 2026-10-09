import { describe, expect, it } from "vitest";
import {
  THEMED_GROUPS,
  THEMES,
  dtcgLeaves,
  readJson,
  tokenGroups,
  type DtcgLeaf,
  type XosTokens,
} from "./source.ts";

const source = readJson<XosTokens>("xos.tokens.json");
const nameMap = readJson<Record<string, string>>("tokens/name-map.json");
const base = dtcgLeaves(readJson("tokens/base.tokens.json"));
const themes = new Map(
  THEMES.map((t) => [t, dtcgLeaves(readJson(`tokens/theme.${t}.tokens.json`))]),
);
const groups = tokenGroups(source);
const allTokens = [...groups.values()].flat();

/** The DTCG value the generator writes for a source value: references renamed, numbers and curves parsed. */
function expectedDtcg(value: string): unknown {
  const ref = /^\{(.+)\}$/.exec(value);
  if (ref?.[1] !== undefined) return `{${nameMap[ref[1]] ?? `unmapped:${ref[1]}`}}`;
  const curve = /^cubic-bezier\((.+)\)$/.exec(value);
  if (curve?.[1] !== undefined) return curve[1].split(",").map((n) => Number(n.trim()));
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function resolve(leaves: Map<string, DtcgLeaf>, value: unknown): unknown {
  const ref = typeof value === "string" ? /^\{(.+)\}$/.exec(value) : null;
  if (ref?.[1] === undefined) return value;
  const target = leaves.get(ref[1]) ?? base.get(ref[1]);
  if (!target) throw new Error(`Broken DTCG reference ${String(value)}`);
  return resolve(leaves, target.$value);
}

describe("xos.tokens.json, DTCG files and name-map stay consistent", () => {
  it("matches the design exports value for value", () => {
    expect(source).toEqual(readJson("../../design/tokens.json"));
    expect(source).toEqual(readJson("../../design/xos-design-system/tokens.json"));
  });

  it("holds 169 tokens across its token groups", () => {
    expect(allTokens).toHaveLength(169);
    expect(new Set(allTokens.map((t) => t.name)).size).toBe(169);
  });

  it("maps every source token one to one onto a unique spec name", () => {
    expect(Object.keys(nameMap).sort()).toEqual(allTokens.map((t) => t.name).sort());
    expect(new Set(Object.values(nameMap)).size).toBe(Object.keys(nameMap).length);
  });

  it("declares the three themes the DTCG files are built for", () => {
    expect(source.color.themes.map((t) => t.id)).toEqual([...THEMES]);
  });

  for (const [group, tokens] of groups) {
    if (THEMED_GROUPS.has(group)) {
      it.each(THEMES)(
        `writes every ${group} token into theme.%s with the source value`,
        (theme) => {
          const leaves = themes.get(theme);
          for (const token of tokens) {
            const raw = typeof token.value === "string" ? token.value : token.value[theme];
            expect(raw, `${token.name} has no ${theme} value`).toBeDefined();
            const leaf = leaves?.get(nameMap[token.name] ?? "");
            expect(leaf?.$value, `${token.name} in theme.${theme}`).toEqual(
              expectedDtcg(raw ?? ""),
            );
          }
        },
      );
    } else {
      it(`writes every ${group} token into base with the source value`, () => {
        for (const token of tokens) {
          expect(typeof token.value).toBe("string");
          const leaf = base.get(nameMap[token.name] ?? "");
          expect(leaf?.$value, token.name).toEqual(expectedDtcg(token.value as string));
        }
      });
    }
  }

  it("keeps theme files to color and shadow tokens, with the same paths in every theme", () => {
    const dark = [...(themes.get("dark")?.keys() ?? [])].sort();
    for (const theme of THEMES) {
      const leaves = themes.get(theme) ?? new Map<string, DtcgLeaf>();
      expect([...leaves.keys()].sort()).toEqual(dark);
      for (const leaf of leaves.values()) expect(["color", "shadow"]).toContain(leaf.$type);
    }
    const themed = allTokens.filter(
      (t) => groups.get("color")?.includes(t) || groups.get("shadow")?.includes(t),
    );
    expect(dark).toHaveLength(themed.length);
  });

  it("adds only font families and type styles to base beyond the name-map", () => {
    const mapped = new Set(Object.values(nameMap));
    const extra = [...base.keys()].filter((p) => !mapped.has(p)).sort();
    const styles = source.type.groups.flatMap((g) => g.styles.map((s) => `typography.${s.name}`));
    const families = Object.keys(source.type.families).map((f) => `font.family.${f}`);
    expect(extra).toEqual([...families, ...styles].sort());
  });

  it("matches font families and every type style to the source type scale", () => {
    for (const [family, stack] of Object.entries(source.type.families)) {
      expect(base.get(`font.family.${family}`)?.$value).toBe(stack);
    }
    for (const group of source.type.groups) {
      for (const style of group.styles) {
        const value = base.get(`typography.${style.name}`)?.$value as Record<string, unknown>;
        expect(value, style.name).toBeDefined();
        expect(resolve(base, value["fontFamily"])).toBe(source.type.families[group.family]);
        expect(value["fontSize"]).toBe(style.fontSize);
        expect(value["lineHeight"]).toBe(style.lineHeight);
        expect(resolve(base, value["fontWeight"])).toBe(style.fontWeight);
      }
    }
  });

  it("resolves every reference in every DTCG file", () => {
    for (const leaves of [base, ...themes.values()]) {
      for (const [path, leaf] of leaves) {
        expect(() => resolve(leaves, leaf.$value), path).not.toThrow();
      }
    }
  });
});
