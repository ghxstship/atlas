import { getNode, isNodeVisible } from "@xos/ia";
import { ChevronRight, Inbox } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import {
  emptyStateHref,
  namesDataRow,
  navigableChildren,
  nodeHref,
  pageCopyKey,
  sitemap,
} from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { ButtonLink, PageHeader } from "./primitives";
import { SystemMessage } from "./system-message";

type Params = Readonly<Record<string, string>>;

/**
 * Route guard for a page (ADR 0006, Section 4.5.9): the org context must exist, the node must be
 * visible to the viewer's role and conditions, and any data row the route names must resolve.
 * Anything else is 404, never 403. The proxy runs the same guard before the request reaches here.
 */
export async function requireNode(node: string, params: Params): Promise<OrgContext> {
  const slug = params["org"] ?? params["partnerSlug"];
  const ctx = slug === undefined ? null : await getOrgContext(slug);
  if (!ctx || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  const route = getNode(sitemap, node).node.route ?? "";
  // Projects (A03), records (A03), saved views (A31) and custom objects (A18) have no table yet,
  // so no key resolves and these routes answer 404 until their owners add the lookup.
  if (namesDataRow(route)) notFound();
  return ctx;
}

/**
 * A page generated from the sitemap (Section 3.15). A node with child pages renders an index of
 * the pages the viewer may open; a page whose module agent has not implemented it yet renders its
 * empty state from the catalog: one sentence and the next action (Section 11.10, rule 10).
 */
export async function SitemapPage({ node, params }: { node: string; params: Params }) {
  const ctx = await requireNode(node, params);
  const t = await getTranslate();
  const entry = getNode(sitemap, node).node;
  const title = t(entry.label);
  const children = navigableChildren(entry).filter((c) => isNodeVisible(sitemap, c.id, ctx.nav));

  if (children.length > 0) {
    return (
      <>
        <PageHeader title={title} />
        <nav aria-label={t("shell.page.sections", { section: title })} className="px-24 py-16">
          <ul className="flex max-w-layout-form flex-col divide-y divide-border-subtle rounded-card border border-border-subtle">
            {children.map((child) => {
              const href = nodeHref(child.id, params);
              return href === undefined ? null : (
                <li key={child.id}>
                  <Link
                    href={href}
                    className="flex min-h-row-comfortable items-center justify-between gap-12 px-16 text-text-14 text-text-primary hover:bg-bg-hover"
                  >
                    {t(child.label)}
                    <ChevronRight
                      aria-hidden="true"
                      className="size-16 text-text-tertiary rtl:rotate-180"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </>
    );
  }

  const copy = pageCopyKey(node);
  return (
    <>
      <PageHeader title={title} />
      <SystemMessage
        icon={Inbox}
        headingLevel={2}
        body={t(`${copy}.empty`)}
        action={
          <ButtonLink href={emptyStateHref(node, params, ctx.nav) as Route} variant="primary">
            {t(`${copy}.action`)}
          </ButtonLink>
        }
      />
    </>
  );
}
