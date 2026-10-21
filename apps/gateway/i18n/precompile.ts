import compile from "icu-minify/compile";

function compileTree(tree: unknown): unknown {
  if (typeof tree === "string") return compile(tree);
  if (typeof tree !== "object" || tree === null) return tree;
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [key, compileTree(value)]));
}

/**
 * Compiles every ICU message of a catalog tree with icu-minify, the form next-intl's format-only
 * runtime reads (ADR 0027). Plain text stays a string. The JSON round trip turns icu-minify's
 * null-prototype option maps into plain objects, which React can pass to the client provider.
 * test/precompile.test.ts checks that every catalog message formats the same compiled as it does
 * through intl-messageformat.
 */
export function precompileMessages<T>(tree: T): T {
  return JSON.parse(JSON.stringify(compileTree(tree))) as T;
}
