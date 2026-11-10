import { getNode, isNodeVisible } from "@xos/ia";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import { TemplateCollection } from "@/components/platform/client/template-collection";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

const SECTIONS = [
  "partner-console",
  "partner-console.client-orgs",
  "partner-console.default-brand",
  "partner-console.usage",
  "partner-console.wholesale-billing",
] as const;

export type PartnerSection = (typeof SECTIONS)[number];

/**
 * The partner console header: the page title and the console's sections as tabs, each shown only when
 * the viewer may open it (wholesale billing is Owner only).
 */
export async function PartnerHeader({
  ctx,
  node,
  actions,
}: {
  ctx: OrgContext;
  node: PartnerSection;
  actions?: ReactNode;
}) {
  const t = await getTranslate();
  const params = { partnerSlug: ctx.org.slug };
  const tabs = SECTIONS.filter((id) => isNodeVisible(sitemap, id, ctx.nav)).flatMap((id) => {
    const href = nodeHref(id, params);
    return href ? [{ id, href, label: t(getNode(sitemap, id).node.label) }] : [];
  });
  return (
    <div className="flex flex-col gap-16 min-w-0">
      <PageHeader title={t(getNode(sitemap, node).node.label)} actions={actions} />
      <nav
        aria-label={t("platform.partner.sections")}
        className="overflow-x-auto overscroll-x-contain"
        tabIndex={0}
      >
        <ul className="m-0 flex list-none gap-4 p-0">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <Link
                href={tab.href as Route}
                aria-current={tab.id === node ? "page" : undefined}
                className={`inline-flex h-control-md items-center whitespace-nowrap rounded-control px-12 text-text-13 font-medium ${
                  tab.id === node
                    ? "bg-bg-selected text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/**
 * A partner console section on the Collection template (Section 11.6): client orgs, usage, wholesale
 * billing and the default brand. The overview is a dashboard instead (app/partner/[partnerSlug]/page.tsx).
 */
export async function PartnerFrame({
  ctx,
  node,
  actions,
  children,
}: {
  ctx: OrgContext;
  node: Exclude<PartnerSection, "partner-console">;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TemplateCollection header={<PartnerHeader ctx={ctx} node={node} actions={actions} />}>
      <div className="flex flex-col gap-16 min-w-0">{children}</div>
    </TemplateCollection>
  );
}
