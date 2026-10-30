/** Which docs sidebar item a page path marks active. */
import { docsPagePath } from "@/lib/brand.ts";

export interface NavGroup {
  readonly label?: string;
  readonly items: readonly { readonly label: string; readonly href: string }[];
}

/**
 * The label of the item whose href best matches the page: the longest href equal to the path or a
 * prefix of it. An org's docs under /o/<slug>/ match as the page they rewrite to (A138), so the
 * server's render and the browser's agree.
 */
export function activeNavLabel(pathname: string, groups: readonly NavGroup[]): string | undefined {
  const path = docsPagePath(pathname);
  let active: string | undefined;
  let best = -1;
  for (const group of groups) {
    for (const item of group.items) {
      const matches = path === item.href || path.startsWith(`${item.href}/`);
      if (matches && item.href.length > best) {
        best = item.href.length;
        active = item.label;
      }
    }
  }
  return active;
}
