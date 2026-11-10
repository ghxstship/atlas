import base, { copyLiterals } from "@xos/config/eslint";

/**
 * The generated theme module carries the token values themselves, so the raw-value rule is off for
 * it; components read colors only through useTheme(). The generator runs on Node.
 * Components take their copy as already translated props (react/jsx-no-literals); the component
 * gallery renders them with sample text, like test fixtures, and is not shipped.
 */
export default [
  ...base,
  ...copyLiterals,
  { files: ["src/gallery/**"], rules: { "react/jsx-no-literals": "off" } },
  {
    files: ["src/theme/tokens.generated.ts"],
    rules: { "xos/no-raw-design-values": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
];
