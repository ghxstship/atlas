/**
 * User-facing copy has one home, the @xos/i18n catalogs (Section 15). JSX text may not be a string
 * literal; props are skipped because class names, test ids and token names are not copy, and the
 * allowed strings are separators that read the same in every locale.
 */

import react from "eslint-plugin-react";

/** The react/jsx-no-literals options every XOS surface shares. */
export const jsxNoLiterals = [
  "error",
  { noStrings: true, ignoreProps: true, allowedStrings: ["·", "/", "…", ":", " "] },
];

/** Files the copy rule skips: tests and end-to-end specs assert on literal text. */
const testFiles = ["**/test/**", "**/tests/**", "**/e2e/**", "**/__tests__/**", "**/*.test.tsx"];

/**
 * Flat config block for packages without eslint-config-next: it registers the React plugin and turns
 * the copy rule on for TSX sources. Next apps already load the plugin, so they use `copyLiteralsRules`.
 */
export const copyLiterals = [
  {
    files: ["**/*.tsx"],
    ignores: testFiles,
    plugins: { react },
    settings: { react: { version: "19" } },
    rules: { "react/jsx-no-literals": jsxNoLiterals },
  },
];

/** The same block without the plugin, for Next apps whose preset registers it. */
export const copyLiteralsRules = [
  { files: ["**/*.tsx"], ignores: testFiles, rules: { "react/jsx-no-literals": jsxNoLiterals } },
];
