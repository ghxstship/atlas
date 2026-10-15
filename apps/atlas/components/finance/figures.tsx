import type { ReactNode } from "react";

/**
 * Presentational pieces for Finance and Reports that need no client state: figure tiles with
 * preformatted, NULL-aware values, titled sections, and the activity timeline built from a
 * lifecycle's transition ledger.
 */

export interface Figure {
  readonly label: string;
  /** Already formatted; an unpriced amount arrives as the catalog's Unpriced label. */
  readonly value: string;
  readonly caption?: string | undefined;
  readonly tone?: "danger" | "warning" | "success" | undefined;
}

export function Figures({ label, items }: { label: string; items: readonly Figure[] }) {
  return (
    <dl
      aria-label={label}
      className="m-0 grid grid-cols-4 gap-12 max-lg:grid-cols-2 max-sm:grid-cols-1"
    >
      {items.map((f) => (
        <div
          key={f.label}
          className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-surface p-12"
        >
          <dt className="text-text-12 text-text-secondary">{f.label}</dt>
          <dd
            className={`m-0 text-heading-20 font-semibold tabular-nums ${
              f.tone === "danger"
                ? "text-danger-text"
                : f.tone === "warning"
                  ? "text-warning-text"
                  : f.tone === "success"
                    ? "text-success-text"
                    : "text-text-primary"
            }`}
          >
            {f.value}
          </dd>
          {f.caption ? <dd className="m-0 text-text-12 text-text-secondary">{f.caption}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export function Section({
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
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export interface ActivityItem {
  readonly id: string;
  readonly text: string;
  readonly reason: string;
  readonly when: string;
}

export function ActivityTimeline({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: readonly ActivityItem[];
}) {
  return (
    <Section id="activity" title={title}>
      {items.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{empty}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-8 border-s border-border-subtle p-0 ps-12">
          {items.map((a) => (
            <li key={a.id} className="flex flex-col gap-2">
              <span className="text-text-13 text-text-primary">{a.text}</span>
              <span className="text-text-12 text-text-secondary">
                {a.reason} · {a.when}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** A simple read-only table for peeks and reports, with real headers (Section 14.1). */
export function SimpleTable({
  caption,
  head,
  rows,
  numeric = [],
  foot,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  numeric?: readonly number[];
  foot?: readonly ReactNode[] | undefined;
}) {
  const align = (i: number) => (numeric.includes(i) ? "text-end tabular-nums" : "text-start");
  return (
    <div role="region" aria-label={caption} tabIndex={0} className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`border-b border-border-subtle px-8 py-6 font-medium text-text-12 text-text-secondary ${align(i)}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-border-subtle">
              {r.map((c, i) => (
                <td key={i} className={`px-8 py-6 ${align(i)}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot ? (
          <tfoot>
            <tr>
              {foot.map((c, i) => (
                <td key={i} className={`px-8 py-6 font-semibold ${align(i)}`}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
