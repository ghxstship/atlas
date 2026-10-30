import { register } from "node:module";

/** `node --import ./src/register-ts.mjs`: lets a CLI import workspace TypeScript (resolve-ts.mjs). */
register("./resolve-ts.mjs", import.meta.url);
