import { resolveBreadcrumbs, type Sitemap } from "@xos/ia";

/** One breadcrumb as the shell's Breadcrumbs takes it. */
export interface CrumbItem {
  readonly label: string;
  readonly href?: string;
}

export interface CrumbContext {
  readonly org: { readonly name: string; readonly slug: string };
  /** The name of the workspace in view, when one is. */
  readonly workspace?: string | undefined;
}

/**
 * The breadcrumb trail of a page (Section 4.5.4): the org, the workspace in view, the pages above it
 * and the record or project it names. The server shell builds the first page's trail from the full
 * sitemap; the client builds the trail of each page it navigates to from the client sitemap
 * (components/shell/route-trail.ts), which loads with the first interaction (ADR 0027).
 */
export function breadcrumbItems(
  sitemap: Sitemap,
  pathname: string,
  { org, workspace }: CrumbContext,
  t: (key: string) => string,
): CrumbItem[] {
  return resolveBreadcrumbs(sitemap, pathname, workspace ? { workspace } : {}).map((c) => {
    if (c.kind === "org") return { label: org.name, href: `/${org.slug}/home` };
    if (c.kind === "workspace") return { label: c.value };
    if (c.kind === "node") return { label: t(c.label), href: c.href };
    return { label: c.value, ...(c.href ? { href: c.href } : {}) };
  });
}
