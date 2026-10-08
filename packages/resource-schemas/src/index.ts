/**
 * @xos/resource-schemas: Zod schemas for every public API resource.
 *
 * Layout mirrors the planned `packages/schemas/src/` tree (`common/` and `resources/`), so the
 * package folds into `packages/schemas` by moving `src/` and re-pointing imports.
 */
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
