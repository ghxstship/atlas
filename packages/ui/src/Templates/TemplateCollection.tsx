import type { ReactElement } from "react";
import { type TemplateCollectionProps } from "./Templates.types.ts";

/** Every list, board, timeline, calendar and table. */
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
      {filters ? <div className="flex flex-wrap items-center gap-6">{filters}</div> : null}
      <div className="min-w-0">{children}</div>
      {bulk ? (
        <div className="sticky bottom-16 flex justify-center print:hidden">{bulk}</div>
      ) : null}
      {peek}
    </div>
  );
}
