import type { ReactNode } from "react";

/** Server building blocks of console pages: a header, titled sections and plain accessible tables. */

export function PageHeader({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-8">
      <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
      {intro ? <p className="m-0 max-w-prose text-text-14 text-text-secondary">{intro}</p> : null}
      {children}
    </header>
  );
}

export function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-12">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      {intro ? <p className="m-0 max-w-prose text-text-13 text-text-secondary">{intro}</p> : null}
      {children}
    </section>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-surface p-16">
      {children}
    </div>
  );
}

/** A table with a caption for screen readers; columns are header labels, rows are cells in the same order. */
export function Table({
  caption,
  columns,
  rows,
  testId,
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly { readonly key: string; readonly cells: readonly ReactNode[] }[];
  testId?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-border-subtle">
      <table className="w-full border-collapse text-start text-text-13" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-bg-surface">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                scope="col"
                className="border-b border-border-subtle px-12 py-8 text-start font-medium text-text-secondary"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border-subtle last:border-b-0">
              {row.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-12 py-8 text-start align-top font-normal">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="px-12 py-8 align-top">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A definition list of label and value pairs. */
export function Facts({
  items,
}: {
  items: readonly { readonly label: string; readonly value: ReactNode }[];
}) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-24 gap-y-8 sm:grid-cols-[max-content_1fr]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-text-13 text-text-secondary">{item.label}</dt>
          <dd className="m-0 text-text-13">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}
