import nextVitals from "eslint-config-next/core-web-vitals";
import base, { serverConsole, sitemapRoutes } from "@xos/config/eslint";

/**
 * Console lint, as Gateway's. On top of the shared preset (raw design values, silent catches), JSX may not hold
 * user-facing string literals: every label comes from the @xos/i18n catalogs (Section 15). Tests and end-to-end
 * specs are exempt from the copy rule.
 */
const config = [
  ...nextVitals,
  ...base,
  ...serverConsole,
  ...(await sitemapRoutes(import.meta.url)),
  {
    files: ["**/*.tsx"],
    ignores: ["**/test/**", "**/e2e/**", "**/*.test.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        { noStrings: true, ignoreProps: true, allowedStrings: ["·", "/", "…", ":", " ", "•"] },
      ],
    },
  },
  { files: ["e2e/**"], rules: { "xos/no-raw-design-values": "off" } },
  { ignores: ["playwright-report/**", "test-results/**"] },
];

export default config;
