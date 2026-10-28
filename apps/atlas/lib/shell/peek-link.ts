/**
 * A link that opens a record in the shell's side peek on the current page (`?peek={recordKey}`),
 * for a page known not to peek its own rows. It needs no sitemap, so the components that use it
 * leave the client sitemap out of their pages (ADR 0027); `peekHref` (peek.ts) asks the sitemap
 * first.
 */
export function shellPeekHref(pathname: string, search: string, recordKey: string): string {
  const params = new URLSearchParams(search);
  params.set("peek", recordKey);
  params.delete("full");
  return `${pathname}?${params.toString()}`;
}
