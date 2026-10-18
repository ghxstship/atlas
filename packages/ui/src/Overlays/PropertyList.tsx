import { type ReactElement, type ReactNode } from "react";

/** Label and value pairs in the record property column. */
export function PropertyList({
  items,
}: {
  items: { label: string; value: ReactNode }[];
}): ReactElement {
  return (
    <dl className="grid grid-cols-[var(--ui-props-label)_1fr] max-sm:grid-cols-1 items-center gap-x-16 gap-y-8 m-0">
      {items.map((p) => (
        <div key={p.label} className="contents">
          <dt className="text-text-12 text-text-secondary">{p.label}</dt>
          <dd className="m-0">{p.value}</dd>
        </div>
      ))}
    </dl>
  );
}
