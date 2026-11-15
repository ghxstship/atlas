import base from "@xos/config/eslint";

/** The release scripts run on Node. */
export default [
  ...base,
  {
    files: ["ci/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
];
