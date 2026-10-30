import type { ReactElement } from "react";
import { type TemplateCollectionProps } from "./Templates.types.ts";

/**
 * Every list, board, timeline, calendar and table. The root (data-template) is the view region of the
 * shell's view shortcuts (lib/shortcut-targets.ts); Open the filters focuses the filter row unless a
 * control in the header, such as the filter builder's Add filter, carries data-shortcut="view.filters".
 */
export function TemplateCollection({
  header,
  filters,
  children,
  peek,
  bulk,
}: TemplateCollectionProps): ReactElement {
  return (
    <div data-template="collection" className="flex flex-col gap-12 min-w-0">
      {header}
      {filters ? (
        <div
          data-shortcut="view.filters"
          data-shortcut-focus=""
          className="flex flex-wrap items-center gap-6"
        >
          {filters}
        </div>
      ) : null}
      <div className="min-w-0">{children}</div>
      {bulk ? (
        <div className="sticky bottom-16 flex justify-center print:hidden">{bulk}</div>
      ) : null}
      {peek}
    </div>
  );
}
