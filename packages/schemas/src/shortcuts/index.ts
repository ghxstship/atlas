/**
 * The keyboard shortcut registry (Section 3.15) for apps: every shell's shortcuts with their scopes,
 * default keys and labels, the reserved keys and the conflict rules, generated from
 * packages/schemas/shortcuts.yaml so browsers and servers read it without the file system. A shell's
 * key handler that needs only the key grammar imports `@xos/schemas/shortcuts/keys`.
 */
export * from "./keys.ts";
export * from "./model.ts";
export { SHORTCUT_REGISTRY } from "./registry.generated.ts";
