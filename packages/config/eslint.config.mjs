import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { designValues, xosPlugin } from "./eslint/no-raw-design-values.mjs";
import { restatedEnums } from "./eslint/no-restated-enums.mjs";

/**
 * Base ESLint preset for every XOS package. Apps extend it with framework rules.
 * Silent catches are refused (Section 19.7): every catch must use its error.
 * Raw colors, pixel sizes and durations are refused in TypeScript (Section 3.15); packages/tokens
 * turns that rule off because it is the home of the values.
 * States and kinds the database defines as enums are read from @xos/data, never written out again.
 */
export const base = tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "all" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
    },
  },
  ...designValues,
  ...restatedEnums.map((block) => ({ ...block, plugins: { xos: xosPlugin } })),
);

export { designValues, noRawDesignValues, xosPlugin } from "./eslint/no-raw-design-values.mjs";
export { noServerConsole, serverConsole } from "./eslint/no-server-console.mjs";
export { noRestatedEnums, restatedEnums } from "./eslint/no-restated-enums.mjs";
export { copyLiterals, copyLiteralsRules, jsxNoLiterals } from "./eslint/copy-literals.mjs";

export default base;
