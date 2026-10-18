import nameMap from "@xos/tokens/name-map.json";

const SPEC = nameMap as Record<string, string>;

/** The CSS variable a white-label token override sets: the spec name with dots as hyphens (`accent-default` is `--color-accent-default`). */
export function tokenVariable(key: string): string {
  const spec = SPEC[key];
  return `--${(spec ?? key).replace(/\./g, "-")}`;
}
