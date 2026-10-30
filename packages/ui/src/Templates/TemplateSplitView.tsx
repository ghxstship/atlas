import type { ReactElement } from "react";
import { ResizablePanel } from "../Layout/Layout.tsx";
import { type TemplateSplitViewProps } from "./Templates.types.ts";

/** A resizable list beside the selected record: Inbox, Dispatch, Advancing, Import review. */
export function TemplateSplitView({
  list,
  detail,
  listWidth = 300,
  listLabel,
}: TemplateSplitViewProps): ReactElement {
  return (
    <div data-template="split-view" className="flex gap-16 min-w-0 max-lg:flex-col">
      <div className="max-lg:[&>div]:w-full! max-lg:[&_[role=separator]]:hidden">
        <ResizablePanel
          initial={listWidth}
          min={240}
          max={480}
          {...(listLabel ? { label: listLabel } : {})}
        >
          {list}
        </ResizablePanel>
      </div>
      <div className="flex-1 min-w-0">{detail}</div>
    </div>
  );
}
