import { URL } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { designValues, xosPlugin } from "./eslint/no-raw-design-values.mjs";
import { restatedEnums } from "./eslint/no-restated-enums.mjs";
import { loadCapabilityCodes, loadExpoRoutes, loadSitemapRoutes } from "./eslint/registries.mjs";

/**
 * Base ESLint preset for every XOS package. Apps extend it with framework rules.
 * Silent catches are refused (Section 19.7): every catch must use its error.
 * Raw colors, pixel sizes and durations are refused in TypeScript (Section 3.15); packages/tokens
 * turns that rule off because it is the home of the values. Capability codes a check names must be
 * in packages/schemas/capabilities.yaml (S3.15-10); apps add `sitemapRoutes` for their paths.
 * States and kinds the database defines as enums are read from @xos/data, never written out again.
 */
const SOURCES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const TESTS = ["**/test/**", "**/tests/**", "**/*.test.ts", "**/*.test.tsx"];

/**
 * Capability codes a check names must exist in the registry. Tests are exempt: they name missing
 * codes on purpose to prove a refusal.
 */
export const capabilities = [
  {
    files: SOURCES,
    ignores: TESTS,
    plugins: { xos: xosPlugin },
    rules: { "xos/registered-capability": ["error", { codes: await loadCapabilityCodes() }] },
  },
];

/**
 * Paths an app links or navigates to must be routes of its sitemap or shell (S3.15-10). `configUrl`
 * is the app's eslint.config.mjs (`import.meta.url`); `ignore` lists patterns for paths served
 * outside the route tree, such as static files.
 */
export async function sitemapRoutes(configUrl, { ignore = [] } = {}) {
  return routeBlock(await loadSitemapRoutes(new URL("./", configUrl)), ignore);
}

/** The same check for an Expo Router app (Compass), against the routes of its `app/` tree. */
export function expoRoutes(configUrl, { ignore = [] } = {}) {
  return routeBlock(loadExpoRoutes(new URL("./", configUrl)), ignore);
}

function routeBlock(routes, ignore) {
  return [
    {
      files: SOURCES,
      ignores: [...TESTS, "**/e2e/**"],
      plugins: { xos: xosPlugin },
      rules: { "xos/registered-route": ["error", { routes, ignore }] },
    },
  ];
}

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
  ...capabilities,
);

export { designValues, noRawDesignValues, xosPlugin } from "./eslint/no-raw-design-values.mjs";
export { noServerConsole, serverConsole } from "./eslint/no-server-console.mjs";
export { noRestatedEnums, restatedEnums } from "./eslint/no-restated-enums.mjs";
export { copyLiterals, copyLiteralsRules, jsxNoLiterals } from "./eslint/copy-literals.mjs";
export { registeredCapability } from "./eslint/registered-capability.mjs";
export { registeredRoute } from "./eslint/registered-route.mjs";

export default base;
