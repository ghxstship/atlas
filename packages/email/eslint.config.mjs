import base, { copyLiterals } from "@xos/config/eslint";

/** Email copy comes from the @xos/i18n email catalog, so template JSX holds no string literals. */
export default [...base, ...copyLiterals];
