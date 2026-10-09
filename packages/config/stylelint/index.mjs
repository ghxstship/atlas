import useLogicalSpec from "stylelint-use-logical-spec";

/**
 * Shared Stylelint config (Section 3.15 source lints, design handoff build step 3, ADR 0010).
 *
 * - Logical properties only (`liberty/use-logical-spec`), so right-to-left locales mirror with
 *   `dir="rtl"` and no extra CSS.
 * - No raw colors: hex, named colors and color functions are refused. `color-mix()` stays allowed
 *   because it mixes token variables; `transparent` and `currentColor` are keywords, not colors.
 * - No raw sizes or durations: `px`, `ms` and `s` units are refused, so lengths and timings come
 *   from token variables. Media and container query features may use `px`, because custom
 *   properties cannot appear there; those values match the breakpoint tokens.
 *
 * Usage, in a package with CSS: `stylelint.config.mjs` containing
 *   `export { default } from "@xos/config/stylelint";`
 * and a lint script `eslint . --max-warnings 0 && stylelint "**\/*.css" --max-warnings 0`.
 */

export const disallowedColorFunctions = [
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
];

export const disallowedUnits = ["px", "ms", "s"];

const queryFeatures = [
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "inline-size",
  "min-inline-size",
  "max-inline-size",
  "block-size",
  "min-block-size",
  "max-block-size",
];

/** @type {import("stylelint").Config} */
const config = {
  plugins: [useLogicalSpec],
  ignoreFiles: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/coverage/**"],
  rules: {
    "liberty/use-logical-spec": "always",
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": disallowedColorFunctions,
    "unit-disallowed-list": [disallowedUnits, { ignoreMediaFeatureNames: { px: queryFeatures } }],
  },
};

export default config;
