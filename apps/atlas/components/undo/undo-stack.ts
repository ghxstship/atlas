/**
 * The session's undo stack, shared with Gateway since A122 (ADR 0082): the module lives in
 * `@xos/ui/undo`, and Atlas's imports keep this path.
 */
export * from "@xos/ui/undo";
