import base from "@xos/config/eslint";

/**
 * @xos/ui keeps the shared preset, including the raw design value rule for every source file.
 * The reference prop contracts are a verbatim copy of the frozen design export, checked by the type
 * test rather than linted. The Tailwind config is CommonJS, as Tailwind 4 loads it through @config.
 */
export default [
  { ignores: ["src/types/reference.d.ts"] },
  ...base,
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
