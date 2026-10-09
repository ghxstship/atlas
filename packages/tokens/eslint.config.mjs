import base from "@xos/config/eslint";

/** The build and gate scripts run on Node, so their runtime globals are declared here. */
export default [
  ...base,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
];
