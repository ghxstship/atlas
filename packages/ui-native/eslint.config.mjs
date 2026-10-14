import base from "@xos/config/eslint";

/**
 * The generated theme module carries the token values themselves, so the raw-value rule is off for
 * it; components read colors only through useTheme(). The generator runs on Node.
 */
export default [
  ...base,
  {
    files: ["src/theme/tokens.generated.ts"],
    rules: { "xos/no-raw-design-values": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
];
