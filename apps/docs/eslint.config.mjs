import nextVitals from "eslint-config-next/core-web-vitals";
import base, { copyLiteralsRules } from "@xos/config/eslint";

/** Docs chrome copy comes from the @xos/i18n catalogs; page prose lives in MDX, which this rule does not read. */
const config = [...nextVitals, ...base, ...copyLiteralsRules];

export default config;
