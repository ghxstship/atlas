import type { ReactElement } from "react";
import { type TemplateDashboardProps } from "./Templates.types.ts";

/** Home, report dashboards and the partner console: tiles on the grid, three columns at lg. */
export function TemplateDashboard({ header, children }: TemplateDashboardProps): ReactElement {
  return (
    <div className="flex flex-col gap-16 min-w-0">
      {header}
      <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-(--layout-gutter-lg)">
        {children}
      </div>
    </div>
  );
}
