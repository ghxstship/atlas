import nextVitals from "eslint-config-next/core-web-vitals";
import base, { serverConsole } from "@xos/config/eslint";

/**
 * Atlas lint. On top of the shared preset (raw design values, silent catches), JSX may not hold
 * user-facing string literals: every label comes from the @xos/i18n catalogs (Section 15). Tests,
 * end-to-end specs and generated route files are exempt from the copy rule.
 */
const config = [
  ...nextVitals,
  ...base,
  ...serverConsole,
  {
    files: ["**/*.tsx"],
    ignores: ["**/test/**", "**/e2e/**", "**/*.test.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        { noStrings: true, ignoreProps: true, allowedStrings: ["·", "/", "…", ":", " "] },
      ],
    },
  },
  // End-to-end specs enter literal values (a failing brand color) as test input.
  { files: ["e2e/**"], rules: { "xos/no-raw-design-values": "off" } },
  { ignores: ["playwright-report/**", "test-results/**"] },
];

export default config;
