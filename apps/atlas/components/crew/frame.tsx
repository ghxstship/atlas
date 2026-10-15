import { getNode, isNodeVisible } from "@xos/ia";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader, TemplateCollection } from "./ui";
import type { CrewContext, SearchParams } from "@/lib/crew/context";
import { navigableChildren, nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { CollectionViews } from "@/components/views/collection-views";

/**
 * The Collection template (Section 11.6) for every People and Crew page: the module's page tabs, the
 * page header with its count, view switcher and one primary action, the filter bar, the view body and
 * the side peek. Views come from the sitemap node's registry entry, so a switcher never offers a view
 * the data does not qualify for (Section 11.15).
 */

export interface FrameProps {
  readonly crew: CrewContext;
  /** The sitemap node of the page. */
  readonly node: string;
  /** The module whose pages appear as tabs: crew or people. */
  readonly module: "crew" | "people";
  readonly params: Readonly<Record<string, string>>;
  readonly search: SearchParams;
  readonly count?: number;
  readonly view: string;
  readonly actions?: ReactNode;
  readonly filters?: ReactNode;
  readonly peek?: ReactNode;
  readonly children: ReactNode;
}

/** The view a page renders: the requested one when the registry offers it, else the default. */
export function resolveView(node: string, requested: string | undefined): string {
  const list = getNode(sitemap, node).node.list;
  if (!list) return "list";
  return requested !== undefined && (list.views as readonly string[]).includes(requested)
    ? requested
    : list.default;
}

export async function CrewFrame(props: FrameProps) {
  const t = await getTranslate();
  const entry = getNode(sitemap, props.node).node;
  const title = t(entry.label);
  const views = entry.list?.views ?? [];
  const pages = navigableChildren(getNode(sitemap, props.module).node)
    .filter((c) => isNodeVisible(sitemap, c.id, props.crew.ctx.nav))
    .flatMap((c) => {
      const href = props.crew.project ? undefined : nodeHref(c.id, props.params);
      return href ? [{ id: c.id, label: t(c.label), href }] : [];
    });

  const switcher =
    views.length > 1 ? (
      <CollectionViews
        label={t("crew.frame.views")}
        value={props.view}
        options={views.map((v) => ({ value: v, label: t(`crew.views.${v}`) }))}
      />
    ) : undefined;

  return (
    <div className="flex flex-col gap-16">
      {pages.length > 0 ? (
        <nav aria-label={t("crew.frame.pages", { module: t(`nav.atlas.items.${props.module}`) })}>
          <ul className="m-0 flex list-none gap-4 overflow-x-auto border-b border-border-subtle p-0">
            {pages.map((p) => {
              const current = p.id === props.node;
              return (
                <li key={p.id}>
                  <Link
                    href={p.href}
                    aria-current={current ? "page" : undefined}
                    className={
                      current
                        ? "inline-flex h-control-lg items-center whitespace-nowrap border-b-stroke-accent border-accent px-8 text-text-13 font-medium text-text-primary"
                        : "inline-flex h-control-lg items-center whitespace-nowrap px-8 text-text-13 text-text-secondary hover:text-text-primary"
                    }
                  >
                    {p.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
      <TemplateCollection
        header={
          <PageHeader
            title={props.crew.project ? `${props.crew.project.name} · ${title}` : title}
            {...(props.count !== undefined ? { count: props.count } : {})}
            {...(switcher ? { views: switcher } : {})}
            {...(props.actions ? { actions: props.actions } : {})}
          />
        }
        {...(props.filters ? { filters: props.filters } : {})}
        {...(props.peek ? { peek: props.peek } : {})}
      >
        {props.children}
      </TemplateCollection>
    </div>
  );
}
