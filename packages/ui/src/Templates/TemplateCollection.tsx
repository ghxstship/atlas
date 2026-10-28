import type { ReactElement } from "react";
import { type TemplateCollectionProps } from "./Templates.types.ts";

/**
 * Every list, board, timeline, calendar and table. The page is a view region for the shell's view
 * shortcuts (data-shortcut-scope, lib/shortcut-targets.ts); Open the filters focuses the filter row
 * unless a control in the header carries data-shortcut="view.filters" first.
 */
export function TemplateCollection({
  header,
  filters,
  children,
  peek,
  bulk,
}: TemplateCollectionProps): ReactElement {
  return (
    <div data-template="collection" data-shortcut-scope="view" className="flex flex-col gap-12 min-w-0">
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
