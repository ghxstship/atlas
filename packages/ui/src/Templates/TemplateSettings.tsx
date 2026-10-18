import type { ReactElement } from "react";
import { type TemplateSettingsProps } from "./Templates.types.ts";

/** Org, personal and project settings: sections beside a centered form column. */
export function TemplateSettings({
  sections,
  children,
  saveBar,
}: TemplateSettingsProps): ReactElement {
  return (
    <div className="grid grid-cols-[var(--ui-settings-nav)_minmax(0,var(--layout-form))] max-md:grid-cols-[minmax(0,1fr)] gap-32 max-md:gap-16">
      <div className="min-w-0">{sections}</div>
      <div className="flex flex-col gap-16 min-w-0">
        {children}
        {saveBar ? (
          <div className="sticky bottom-0 flex items-center justify-end gap-8 py-12 bg-bg-canvas border-t border-border-subtle">
            {saveBar}
          </div>
        ) : null}
      </div>
    </div>
  );
}
