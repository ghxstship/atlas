import type { ReactElement } from "react";
import { type TemplateGridEditorProps } from "./Templates.types.ts";

/** Spreadsheet-speed editing: a full-width grid under its header. */
export function TemplateGridEditor({
  header,
  children,
  toolbar,
}: TemplateGridEditorProps): ReactElement {
  return (
    <div data-template="grid-editor" className="flex flex-col gap-12 min-w-0">
      {header}
      {toolbar ? <div className="flex flex-wrap items-center gap-8">{toolbar}</div> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
