/**
 * The session's undo stack, shared with Gateway since A122 (ADR 0082): the module lives in
 * `@xos/ui/undo`, which Atlas's components import directly. This path stays for code that still
 * names it.
 */
export * from "@xos/ui/undo";
