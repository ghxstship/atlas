import type { ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type TemplateRecordProps } from "./Templates.types.ts";

/** Every record full page: content and activity beside the 320 px property column. */
export function TemplateRecord({
  header,
  children,
  properties,
  related,
  propertiesLabel,
}: TemplateRecordProps): ReactElement {
  return (
    <article className="flex flex-col gap-16 min-w-0">
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)_var(--layout-property-column)] max-lg:grid-cols-[minmax(0,1fr)] gap-24">
        <div className="flex flex-col gap-16 min-w-0">{children}</div>
        <aside
          aria-label={propertiesLabel}
          className={cx(
            "min-w-0 ps-20 border-s border-border-subtle",
            "max-lg:ps-0 max-lg:border-s-0 max-lg:pt-16 max-lg:border-t",
          )}
        >
          {properties}
        </aside>
      </div>
      {related ? <section className="min-w-0">{related}</section> : null}
    </article>
  );
}
