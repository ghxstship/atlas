import base from "@xos/config/eslint";

export default [
  ...base,
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
