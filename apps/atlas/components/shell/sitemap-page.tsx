import { getNode, isNodeVisible } from "@xos/ia";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { requireNode } from "@/lib/shell/require-node";
import { EmptyStateLink, PageHeader } from "@/components/ui";
import {
  emptyStateHref,
  navigableChildren,
  nodeHref,
  pageCopyKey,
  sitemap,
} from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

type Params = Readonly<Record<string, string>>;

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
        <nav aria-label={t("shell.page.sections", { section: title })}>
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
      <EmptyStateLink
        icon="Inbox"
        sentence={t(`${copy}.empty`)}
        actionLabel={t(`${copy}.action`)}
        href={emptyStateHref(node, params, ctx.nav)}
      />
    </>
  );
}
