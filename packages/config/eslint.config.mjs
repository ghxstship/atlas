import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Base ESLint preset for every XOS package. Apps extend it with framework rules.
 * Silent catches are refused (Section 19.7): every catch must use its error.
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
);

export default base;
