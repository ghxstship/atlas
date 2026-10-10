/** Joins class names, dropping falsy entries. Every class string in this package goes through cx or a className literal, which the utility test scans. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
