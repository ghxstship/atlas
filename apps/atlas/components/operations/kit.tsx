import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ScrollRegion } from "@/components/ui";
import { CollectionViews } from "@/components/views/collection-views";

/**
 * Server-rendered building blocks shared by the Credentials and Safety incident pages (A14): the
 * view switcher, the filter bar, a responsive table, a list, a board, property rows and the panels
 * whose platform feature has not landed yet. They compose the @xos/ui templates (Section 11.6) and
 * keep every control a plain link or form, so each page works by keyboard and without scripts.
 */

export { hrefWith, joined, param, type SearchParams } from "./query";

/**
 * The view switcher (Section 11.15): only the views the sitemap declares for the page, with the
 * person's saved views of the page (A31's shared CollectionViews). Switching keeps the section and
 * every filter in the query string.
 */
export function ViewSwitcher({
  label,
  views,
  current,
}: {
  label: string;
  views: readonly { value: string; label: string }[];
  current: string;
}) {
  return <CollectionViews label={label} value={current} options={views} />;
}

export interface FilterField {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
}

/**
 * Filters as a GET form, so the filter state lives in the URL (Section 4.5.3) and survives a view
 * switch. Hidden fields carry the query parameters the form does not change.
 */
export function FilterBar({
  label,
  action,
  fields,
  keep,
  submitLabel,
}: {
  label: string;
  action: string;
  fields: readonly FilterField[];
  keep: Readonly<Record<string, string | undefined>>;
  submitLabel: string;
}) {
  return (
    <form
      action={action}
      method="get"
      aria-label={label}
      className="flex flex-wrap items-end gap-8"
    >
      {Object.entries(keep).map(([name, value]) =>
        value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-4 text-text-12 text-text-secondary">
          {f.label}
          <select
            name={f.name}
            defaultValue={f.value}
            className="min-h-control-sm rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary"
          >
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button
        type="submit"
        className="min-h-control-sm rounded-control border border-border-control bg-bg-surface px-12 text-label-13 text-text-primary hover:bg-bg-hover"
      >
        {submitLabel}
      </button>
    </form>
  );
}

export interface Column<Row> {
  readonly key: string;
  readonly label: string;
  /** Shown below md, where the table becomes stacked cards (Section 11.6). Keep three. */
  readonly primary?: boolean;
  readonly numeric?: boolean;
  readonly render: (row: Row) => ReactNode;
}

/**
 * A table whose first column links each row to its peek. Below md only the primary columns stay,
 * so the table reads as stacked rows on a phone without sideways scrolling.
 */
export function OpsTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowHref,
  selected,
}: {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  rowHref?: (row: Row) => Route;
  selected?: string | undefined;
}) {
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-card border border-border-subtle"
    >
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-subtle text-start text-text-12 text-text-secondary">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-12 py-8 font-medium ${c.numeric ? "text-end" : "text-start"} ${c.primary ? "" : "max-md:hidden"}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                aria-selected={selected === key ? true : undefined}
                className="border-b border-border-subtle last:border-b-0 hover:bg-bg-hover aria-selected:bg-bg-raised"
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={`px-12 py-8 align-top ${c.numeric ? "text-end tabular-nums" : ""} ${c.primary ? "" : "max-md:hidden"}`}
                  >
                    {i === 0 && rowHref ? (
                      <Link
                        href={rowHref(row)}
                        className="font-medium text-text-primary underline-offset-2 hover:underline"
                      >
                        {c.render(row)}
                      </Link>
                    ) : (
                      c.render(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface ListItem {
  readonly key: string;
  readonly href: Route;
  readonly title: ReactNode;
  readonly meta: ReactNode;
  readonly trailing?: ReactNode;
}

/** A list of records, one link per row (the List view). */
export function OpsList({ label, items }: { label: string; items: readonly ListItem[] }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
    >
      {items.map((item) => (
        <li key={item.key}>
          <Link
            href={item.href}
            className="flex min-h-row-comfortable flex-wrap items-center justify-between gap-8 px-16 py-8 hover:bg-bg-hover"
          >
            <span className="flex min-w-0 flex-col gap-2">
              <span className="text-text-14 font-medium text-text-primary">{item.title}</span>
              <span className="text-text-12 text-text-secondary">{item.meta}</span>
            </span>
            {item.trailing ? <span className="shrink-0">{item.trailing}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export interface BoardColumn {
  readonly key: string;
  readonly label: string;
  readonly items: readonly ListItem[];
  readonly empty: string;
}

/** The Board view: one column per state, cards that open the peek. */
export function OpsBoard({ label, columns }: { label: string; columns: readonly BoardColumn[] }) {
  // The columns scroll sideways in a region whose cut-off edge fades (A59-012).
  return (
    <ScrollRegion label={label} className="pb-8">
      <div className="grid auto-cols-[minmax(var(--layout-property-column),1fr)] grid-flow-col gap-12 max-md:grid-flow-row max-md:auto-cols-auto">
        {columns.map((col) => (
          <section
            key={col.key}
            aria-labelledby={`board-${col.key}`}
            className="flex min-w-0 flex-col gap-8 rounded-card bg-bg-raised p-8"
          >
            <h2
              id={`board-${col.key}`}
              className="m-0 flex items-center justify-between px-4 text-label-13 font-semibold"
            >
              {col.label}
              <span className="tabular-nums text-text-secondary">{col.items.length}</span>
            </h2>
            {col.items.length === 0 ? (
              <p className="m-0 px-4 text-text-12 text-text-secondary">{col.empty}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-6 p-0">
                {col.items.map((item) => (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-surface p-12 hover:border-border-strong"
                    >
                      <span className="text-text-13 font-medium text-text-primary">
                        {item.title}
                      </span>
                      <span className="text-text-12 text-text-secondary">{item.meta}</span>
                      {item.trailing ? <span>{item.trailing}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </ScrollRegion>
  );
}

/** The property column of a record (Section 11.6, Record template). */
export function Properties({
  label,
  rows,
}: {
  label: string;
  rows: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <dl aria-label={label} className="m-0 grid grid-cols-[auto_1fr] gap-x-12 gap-y-8">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-text-12 text-text-secondary">{r.label}</dt>
          <dd className="m-0 min-w-0 text-text-13 break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A titled section inside a record. */
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
    <section aria-labelledby={id} className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id={id} className="m-0 text-text-14 font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A small tone chip whose text always carries the meaning (color is never alone). */
export function ToneChip({
  tone,
  children,
}: {
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const tones = {
    neutral: "text-text-secondary",
    accent: "text-accent-text",
    success: "text-success-text",
    warning: "text-warning-text",
    danger: "text-danger-text",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-chip border border-border-subtle bg-bg-raised px-6 py-2 text-text-12 font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
