/**
 * The settings registry (Section 4.5.6) for apps: every setting from every contributor file,
 * generated into a module so browsers and servers read it without the file system.
 */
export * from "./model.ts";
export { SETTINGS } from "./registry.generated.ts";
