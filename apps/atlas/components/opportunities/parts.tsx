import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Server-rendered building blocks shared by the Opportunities pages: the view switcher (only views the sitemap declares
 * for the page, state kept in the query string, Section 11.15), a semantic table that becomes stacked cards below `md`
 * (Section 11.6), a property list for the record panel, and titled sections.
 */

export function ViewSwitch({
  label,
  views,
  current,
  hrefFor,
}: {
  label: string;
  views: readonly { readonly id: string; readonly label: string }[];
  current: string;
  hrefFor: (view: string) => string;
}) {
  if (views.length < 2) return null;
  return (
    <nav aria-label={label}>
      <ul className="m-0 flex list-none gap-2 rounded-control border border-border-subtle p-2">
        {views.map((v) => (
          <li key={v.id}>
            <Link
              href={hrefFor(v.id) as Route}
              aria-current={v.id === current ? "page" : undefined}
              className={`flex min-h-row-compact items-center rounded-control px-8 text-text-13 ${
                v.id === current
                  ? "bg-bg-selected font-medium text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {v.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface TableColumn<T> {
  readonly key: string;
  readonly label: string;
  readonly cell: (row: T) => ReactNode;
  readonly numeric?: boolean;
}

export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-border-subtle max-md:border-0">
      <table className="w-full border-collapse text-text-13 max-md:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="max-md:hidden">
          <tr className="border-b border-border-subtle text-start">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-12 py-8 font-medium text-text-secondary ${c.numeric ? "text-end" : "text-start"}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-md:flex max-md:flex-col max-md:gap-8">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-border-subtle last:border-b-0 hover:bg-bg-hover max-md:flex max-md:flex-col max-md:rounded-card max-md:border max-md:p-12"
            >
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={`px-12 py-8 align-top max-md:px-0 max-md:py-2 ${c.numeric ? "text-end tabular-nums max-md:text-start" : ""} ${
                    i > 2 ? "max-md:hidden" : ""
                  }`}
                >
                  <span className="hidden text-text-12 text-text-tertiary max-md:block">
                    {c.label}
                  </span>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Properties({
  label,
  items,
}: {
  label: string;
  items: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <dl
      aria-label={label}
      className="m-0 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-12 gap-y-8 text-text-13"
    >
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-text-secondary">{item.label}</dt>
          <dd className="m-0 min-w-0 break-words text-text-primary">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-8">
      <h2 id={id} className="m-0 text-heading-14 font-semibold text-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href as Route}
      className="font-medium text-text-primary underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

/** A muted sentence for an empty part of a record, naming the next action. */
export function Muted({ children }: { children: ReactNode }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}
