import base, { copyLiterals, expoRoutes } from "@xos/config/eslint";

/** Compass labels come from the @xos/i18n catalogs, so JSX holds no string literals (Section 15). */
export default [
  ...base,
  ...copyLiterals,
  ...expoRoutes(import.meta.url),
  {
    ignores: ["ios/**", "android/**", ".expo/**", "dist/**"],
  },
  {
    files: ["scripts/**/*.ts"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // Metro loads its config as CommonJS.
    files: ["metro.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", __dirname: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
