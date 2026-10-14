import base from "@xos/config/eslint";

/** The registry generator runs on Node. */
export default [
  ...base,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
];
