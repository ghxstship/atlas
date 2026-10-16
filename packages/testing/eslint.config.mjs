import shared from "@xos/config/eslint";

/** The k6 scripts run in k6's runtime, which provides these globals. */
const k6Globals = { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" };

export default [
  ...(Array.isArray(shared) ? shared : [shared]),
  { files: ["load/**/*.js"], languageOptions: { globals: k6Globals } },
];
