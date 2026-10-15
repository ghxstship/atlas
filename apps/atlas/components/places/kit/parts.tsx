import { ArrowLeft } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import type { Translate } from "@/lib/shell/translate";
import { ViewSwitcher } from "./client";
import { InlineAlert, PageHeader, TemplateCollection } from "./ui";
import { withQuery, type ViewChoice } from "./views";

/**
 * Server parts of the Places and Safety pages, composed into the design system's Collection and
 * Record templates (Section 11.6). Copy comes from the `places` and `permits` catalogs through the
 * translator each page passes in.
 */

export type Search = Readonly<Record<string, string | string[] | undefined>>;

/** The Collection template with a header, a filter row and an optional peek or drawer. */
export function Collection({
  title,
  count,
  views,
  primary,
  filters,
  overlay,
  children,
}: {
  title: string;
  count?: number;
  views: ViewChoice;
  primary?: ReactNode;
  filters?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={title}
          {...(count === undefined ? {} : { count })}
          views={<ViewSwitcher offered={views.offered} current={views.current} />}
          actions={primary}
        />
      }
      filters={filters}
      peek={overlay}
    >
      {children}
    </TemplateCollection>
  );
}

/** The one primary action of a collection: opens the create drawer through `?create=1`. */
export function CreateLink({ path, search, label }: { path: string; search: Search; label: string }) {
  return (
    <ButtonLink href={withQuery(path, search, { create: "1", peek: undefined })} variant="primary">
      {label}
    </ButtonLink>
  );
}

/** Live, archived or all rows. Archived rows are restorable, never deleted (Section 11.7). */
export function ArchiveFilter({
  path,
  search,
  current,
  t,
}: {
  path: string;
  search: Search;
  current: "live" | "archived" | "all";
  t: Translate;
}) {
  return (
    <nav aria-label={t("places.kit.archive.label")} className="flex items-center gap-4">
      {(["live", "archived", "all"] as const).map((value) => (
        <Link
          key={value}
          href={withQuery(path, search, { archive: value === "live" ? undefined : value }) as Route}
          aria-current={value === current ? "page" : undefined}
          className="rounded-chip px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover aria-[current=page]:bg-bg-hover aria-[current=page]:text-text-primary aria-[current=page]:font-medium"
        >
          {t(`places.kit.archive.${value}`)}
        </Link>
      ))}
    </nav>
  );
}

/** A search box that filters the collection through `?q=`, without JavaScript. */
export function SearchBox({
  path,
  search,
  label,
}: {
  path: string;
  search: Search;
  label: string;
}) {
  const q = typeof search["q"] === "string" ? search["q"] : "";
  return (
    <form action={path} method="get" role="search" className="flex items-center gap-4">
      {Object.entries(search).flatMap(([key, value]) =>
        key === "q" || key === "peek" || typeof value !== "string"
          ? []
          : [<input key={key} type="hidden" name={key} value={value} />],
      )}
      <label className="sr-only" htmlFor="collection-search">
        {label}
      </label>
      <input
        id="collection-search"
        name="q"
        type="search"
        defaultValue={q}
        className="h-control-sm w-[min(calc(var(--space-40)*6),100%)] rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary"
      />
    </form>
  );
}

/** A select-style filter as links, for project and venue filters. */
export function LinkFilter({
  path,
  search,
  label,
  queryKey,
  allLabel,
  options,
}: {
  path: string;
  search: Search;
  label: string;
  queryKey: string;
  allLabel: string;
  options: readonly { value: string; label: string }[];
}) {
  const current = typeof search[queryKey] === "string" ? search[queryKey] : undefined;
  const summary = `${label}: ${options.find((o) => o.value === current)?.label ?? allLabel}`;
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-chip border border-border-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover">
        {summary}
      </summary>
      <ul className="absolute z-popover mt-4 flex max-h-[50vh] min-w-[calc(var(--space-40)*5)] flex-col overflow-y-auto rounded-card border border-border-subtle bg-bg-raised p-4 shadow-menu">
        {[{ value: undefined, label: allLabel }, ...options].map((o) => (
          <li key={o.value ?? "all"}>
            <Link
              href={withQuery(path, search, { [queryKey]: o.value, peek: undefined }) as Route}
              aria-current={o.value === current ? "true" : undefined}
              className="block rounded-chip px-8 py-6 text-text-13 hover:bg-bg-hover aria-[current=true]:font-medium"
            >
              {o.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One row of a list view: a link that opens the peek, with secondary text and chips. */
export interface ListRow {
  readonly id: string;
  readonly title: string;
  readonly meta?: string;
  readonly chips?: ReactNode;
  readonly trailing?: ReactNode;
}

export function EntityList({
  label,
  path,
  search,
  rows,
}: {
  label: string;
  path: string;
  search: Search;
  rows: readonly ListRow[];
}) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
    >
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={withQuery(path, search, { peek: row.id, full: undefined, create: undefined }) as Route}
            scroll={false}
            className="flex min-h-row-comfortable flex-wrap items-center justify-between gap-8 px-16 py-8 hover:bg-bg-hover focus-visible:bg-bg-hover"
          >
            <span className="flex min-w-0 flex-col gap-2">
              <span className="text-text-14 font-medium text-text-primary">{row.title}</span>
              {row.meta ? <span className="text-text-12 text-text-secondary">{row.meta}</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-6">
              {row.chips}
              {row.trailing}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The empty state of a collection: one sentence and the next action (Section 11.10, rule 10). */
export function CollectionEmpty({
  sentence,
  actionLabel,
  href,
  icon = "Inbox",
}: {
  sentence: string;
  actionLabel: string;
  href: string;
  icon?: string;
}) {
  return <EmptyStateLink icon={icon} sentence={sentence} actionLabel={actionLabel} href={href} />;
}

/**
 * Comments and attachments are blocked until A18 ships the unified comment and attachment system
 * (orchestrator broadcast 1, item 3). The panel names the feature and says what happens next.
 */
export function BlockedCollaboration({ t }: { t: Translate }) {
  return (
    <section aria-labelledby="collaboration-heading" className="flex flex-col gap-8">
      <h2 id="collaboration-heading" className="m-0 text-text-14 font-semibold">
        {t("places.kit.collaboration.title")}
      </h2>
      <InlineAlert tone="info" title={t("places.kit.collaboration.blockedTitle")}>
        {t("places.kit.collaboration.blockedBody")}
      </InlineAlert>
    </section>
  );
}

/** A link back from a full record page to the collection, keeping its filters. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href as Route}
      className="inline-flex items-center gap-4 text-text-13 text-text-secondary hover:text-text-primary"
    >
      <ArrowLeft aria-hidden="true" className="size-16 rtl:rotate-180" />
      {label}
    </Link>
  );
}

/** A plain section heading inside a record page. */
export function RecordSection({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id={`${id}-heading`} className="m-0 text-text-14 font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
