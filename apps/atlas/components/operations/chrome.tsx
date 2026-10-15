import type { Result } from "@xos/data";
import type { Route } from "next";
import Link from "next/link";
import type { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { FilterBar, hrefWith, param, ViewSwitcher } from "@/components/operations/kit";
import { PeekPanel } from "@/components/operations/peek";
import { TemplateRecord } from "@/components/operations/ui";
import { EmptyStateLink, PageHeader } from "@/components/ui";
import type { ModulePage } from "@/lib/operations/context";

/**
 * The chrome every Credentials and Safety incident section shares: the Collection header with its
 * view switcher, the project filter, the notice that asks for a project, and the record shown as a
 * side peek or a full page (Section 11.6, Collection and Record templates).
 */

export type Format = Awaited<ReturnType<typeof getFormatter>>;

export function unwrap<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`Cannot load ${what}: ${JSON.stringify(result.error)}`);
  return result.data;
}

export function dateTime(format: Format, iso: string | null, timeZone?: string): string {
  return iso
    ? format.dateTime(new Date(iso), {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timeZone ? { timeZone } : {}),
      })
    : "";
}

/** The query state a section keeps when it links to itself. */
export function sectionHref(page: ModulePage, changes: Record<string, string | undefined>): Route {
  return hrefWith(page.base, page.search, changes);
}

export function Header({
  page,
  section,
  title,
  count,
  views,
  view,
  action,
}: {
  page: ModulePage;
  section: string;
  title: string;
  count?: number;
  views: readonly string[];
  view: string;
  action?: ReactNode;
}) {
  const t = page.t;
  return (
    <PageHeader
      title={title}
      {...(count !== undefined ? { count } : {})}
      views={
        <ViewSwitcher
          label={t("credentials.common.viewsLabel", { section: title })}
          views={views.map((v) => ({ value: v, label: t(`credentials.common.views.${v}`) }))}
          current={view}
          hrefFor={(v) => sectionHref(page, { view: v, section })}
        />
      }
      actions={action}
    />
  );
}

export function ProjectFilter({
  page,
  section,
  extra = [],
}: {
  page: ModulePage;
  section: string;
  extra?: readonly {
    name: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
  }[];
}) {
  const t = page.t;
  const fields = [
    ...(page.projectFixed
      ? []
      : [
          {
            name: "project",
            label: t("credentials.common.project"),
            value: page.project?.key ?? "",
            options: [
              { value: "", label: t("credentials.common.allProjects") },
              ...page.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
            ],
          },
        ]),
    ...extra,
  ];
  if (fields.length === 0) return null;
  return (
    <FilterBar
      label={t("credentials.common.filters")}
      action={page.base}
      fields={fields}
      keep={{ view: param(page.search, "view"), section: page.projectFixed ? section : undefined }}
      submitLabel={t("credentials.common.apply")}
    />
  );
}

/** Where to go when the viewer may act but no project is in scope yet. */
export function chooseProjectNotice(page: ModulePage, section: string): ReactNode {
  const t = page.t;
  const first = page.projects[0];
  return first ? (
    <EmptyStateLink
      icon="FolderOpen"
      sentence={t("credentials.common.chooseProject")}
      actionLabel={t("credentials.common.openProject", { key: first.key })}
      href={sectionHref(page, { project: first.key, section })}
    />
  ) : (
    <EmptyStateLink
      icon="FolderOpen"
      sentence={t("credentials.common.noProjects")}
      actionLabel={t("credentials.common.goToProjects")}
      href={`/${page.ctx.org.slug}/projects`}
    />
  );
}

export function RecordChrome({
  page,
  full,
  title,
  recordKey,
  kindLabel,
  closeHref,
  fullHref,
  children,
  properties,
}: {
  page: ModulePage;
  full: boolean;
  title: string;
  recordKey: string;
  kindLabel: string;
  closeHref: Route;
  fullHref: Route;
  children: ReactNode;
  properties: ReactNode;
}) {
  const t = page.t;
  if (full) {
    return (
      <TemplateRecord
        propertiesLabel={t("credentials.common.properties")}
        header={
          <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
            <Link href={closeHref} className="text-text-12 text-text-secondary hover:underline">
              {t("credentials.common.backToList")}
            </Link>
            <span className="flex items-center gap-6 text-text-12 text-text-secondary">
              <span>{kindLabel}</span>
              <span className="font-mono">{recordKey}</span>
            </span>
            <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
          </header>
        }
        properties={properties}
      >
        {children}
      </TemplateRecord>
    );
  }
  return (
    <PeekPanel
      title={title}
      recordKey={recordKey}
      kindLabel={kindLabel}
      closeHref={closeHref}
      fullHref={fullHref}
      closeLabel={t("credentials.common.close")}
      fullLabel={t("credentials.common.openFull")}
    >
      {properties}
      {children}
    </PeekPanel>
  );
}

export function RecordMissing({ page, closeHref }: { page: ModulePage; closeHref: Route }) {
  const t = page.t;
  return (
    <EmptyStateLink
      icon="SearchX"
      sentence={t("credentials.common.recordMissing")}
      actionLabel={t("credentials.common.backToList")}
      href={closeHref}
    />
  );
}
