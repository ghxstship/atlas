/**
 * Key-by-key fallback for Beta catalogs (Section 15, ADR 0053). A Beta locale's catalog is whatever the
 * Google Translate pipeline (ADR 0037) has written so far: some namespaces, some keys, or nothing. The
 * merged catalog has exactly the keys of en-US; each one reads the Beta translation when there is one
 * and en-US otherwise, so a screen never shows a raw key.
 */

type Tree = { readonly [key: string]: string | Tree };

/** A catalog with any subset of the source catalog's keys. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]>;
};

/** A Beta catalog as the pipeline writes it: any subset of the en-US namespaces and keys. */
export type PartialMessages = { readonly [namespace: string]: unknown };

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The source catalog with every key the partial catalog translates replaced by its translation. Keys
 * the source lacks are dropped, and an empty or non-string translation counts as missing.
 */
export function withFallback<T extends object>(source: T, partial: unknown): T {
  const theirs = isTree(partial) ? partial : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const translated = theirs[key];
    if (typeof value === "string") {
      out[key] = typeof translated === "string" && translated.trim() !== "" ? translated : value;
    } else if (isTree(value)) {
      out[key] = withFallback(value, translated);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** How many of the source catalog's messages a partial catalog translates. */
export function coverage(source: object, partial: unknown): { translated: number; total: number } {
  let translated = 0;
  let total = 0;
  const walk = (node: object, theirs: unknown) => {
    const other = isTree(theirs) ? theirs : {};
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        total += 1;
        const t = other[key];
        if (typeof t === "string" && t.trim() !== "") translated += 1;
      } else if (isTree(value)) walk(value, other[key]);
    }
  };
  walk(source, partial);
  return { translated, total };
}
