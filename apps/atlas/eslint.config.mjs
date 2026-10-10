import nextVitals from "eslint-config-next/core-web-vitals";
import base from "@xos/config/eslint";

/**
 * Atlas lint. On top of the shared preset (raw design values, silent catches), JSX may not hold
 * user-facing string literals: every label comes from the @xos/i18n catalogs (Section 15). Tests,
 * end-to-end specs and generated route files are exempt from the copy rule.
 */
const config = [
  ...nextVitals,
  ...base,
  {
    files: ["**/*.tsx"],
    ignores: ["**/test/**", "**/e2e/**", "**/*.test.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        { noStrings: true, ignoreProps: true, allowedStrings: ["·", "/", "…", ":"] },
      ],
    },
  },
  { ignores: ["playwright-report/**", "test-results/**"] },
];

export default config;
