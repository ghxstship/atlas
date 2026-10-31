/* XOS contrast gate. Usage: node check-contrast.js <tokens.json> <contrast-pairs.json>
   Exits 1 when any declared pair falls under its WCAG 2.2 AA threshold in any theme.
   Ported from design/xos-design-system/export/check-contrast.js to an ES module with the same
   arithmetic and output; the functions are exported for tests and the white-label theme editor. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { composite, ratio } from "./ratio.js";

export { composite, ratio };

/** Resolves a color token to its hex value in a theme, following `{name}` references. */
export function resolveColor(tokens, name, theme) {
  const themes = tokens.color.themes.map((t) => t.id);
  const t = tokens.color.tokens.find((c) => c.name === name);
  if (!t) throw new Error("Unknown color token: " + name);
  const v =
    typeof t.value === "string"
      ? t.value
      : t.value[theme] !== undefined
        ? t.value[theme]
        : t.value[themes[0]];
  const m = /^\{(.+)\}$/.exec(v);
  return m ? resolveColor(tokens, m[1], theme) : v;
}

/**
 * Checks every declared pair in every theme. Returns the pair count and each failure. A rule with
 * `overlays` also checks each background with each overlay composited over it (hover, pressed).
 */
export function checkContrast(tokens, spec) {
  const themes = tokens.color.themes.map((t) => t.id);
  const failures = [];
  let checked = 0;
  for (const theme of themes) {
    for (const rule of spec.rules) {
      for (const fg of rule.fg) {
        for (const bg of rule.bg) {
          const fill = resolveColor(tokens, bg, theme);
          const states = [
            { label: bg, hex: fill },
            ...(rule.overlays || []).map((o) => ({
              label: bg + " " + o.state + " (" + o.color + " at " + o.opacity + ")",
              hex: composite(fill, resolveColor(tokens, o.color, theme), o.opacity),
            })),
          ];
          for (const state of states) {
            checked++;
            const r = ratio(resolveColor(tokens, fg, theme), state.hex);
            if (r < rule.min)
              failures.push({
                theme,
                rule: rule.name,
                fg,
                bg: state.label,
                ratio: r,
                min: rule.min,
              });
          }
        }
      }
    }
  }
  return { checked, themes: themes.length, failures };
}

/** Formats a failure exactly as the reference gate prints it. */
export function formatFailure(f) {
  return (
    "FAIL " +
    f.theme +
    " " +
    f.rule +
    ": " +
    f.fg +
    " on " +
    f.bg +
    " = " +
    f.ratio.toFixed(2) +
    ":1 (needs " +
    f.min +
    ":1)"
  );
}

function main(argv) {
  const tokens = JSON.parse(readFileSync(argv[2] || "tokens.json", "utf8"));
  const spec = JSON.parse(readFileSync(argv[3] || "contrast-pairs.json", "utf8"));
  const result = checkContrast(tokens, spec);
  for (const f of result.failures) console.log(formatFailure(f));
  console.log(
    result.checked +
      " pairs checked across " +
      result.themes +
      " themes, " +
      result.failures.length +
      " failing.",
  );
  process.exit(result.failures.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
