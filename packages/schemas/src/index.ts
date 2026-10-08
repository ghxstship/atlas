/**
 * @xos/schemas package entry: the Zod resource schemas of the public API, plus the capability
 * registry as a namespace. `@xos/schemas/capabilities` remains the direct registry entry.
 */
export * as capabilities from "./capabilities/index.ts";

export * as canonCodes from "./common/canon-codes.ts";
export * as fields from "./common/fields.ts";
export * from "./common/enums.ts";
export * from "./common/envelope.ts";
export * from "./common/examples.ts";
export * from "./common/resource.ts";

export * as canon from "./resources/canon.ts";
export * as projects from "./resources/projects.ts";
export * as records from "./resources/records.ts";
export * as operations from "./resources/operations.ts";
export * as workforce from "./resources/workforce.ts";
export * as finance from "./resources/finance.ts";
export * as safety from "./resources/safety.ts";
export * as marketplace from "./resources/marketplace.ts";
export * as identity from "./resources/identity.ts";
export * as platform from "./resources/platform.ts";
