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
];
