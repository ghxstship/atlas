import base from "@xos/config/eslint";

/**
 * The build and gate scripts run on Node; the Tailwind fixture is a CommonJS config as apps write it.
 * This package is the home of design values, so the raw-value rule is off here.
 */
export default [
  ...base,
  { rules: { "xos/no-raw-design-values": "off" } },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
