/**
 * Create menu entries in the order the page the person is on calls for. No imports, so the menu's
 * on-demand chunk stays small.
 */

/** One entry of the Create menu as the shell renders it (create-menu.ts builds them). */
export interface CreateItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** The page's address; the menu adds the create flag. */
  readonly page: string;
}

/**
 * The Create menu for the page the person is on (Section 11.2: C creates in the current context): the
 * kind this page creates first, then the rest of its module, then everything else. So C then Enter
 * starts this page's own create flow.
 */
export function orderForPage(
  items: readonly CreateItem[],
  pathname: string,
): { readonly here: CreateItem[]; readonly rest: CreateItem[] } {
  const section = (path: string) => path.split("/")[2] ?? "";
  const onPage = (i: CreateItem) => pathname === i.page || pathname.startsWith(`${i.page}/`);
  const nearby = (i: CreateItem) => !onPage(i) && section(i.page) === section(pathname);
  const here = [...items.filter(onPage), ...items.filter(nearby)];
  return { here, rest: items.filter((i) => !here.includes(i)) };
}
