import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { type PageHeaderProps } from "./Layout.types.ts";

/** Title, count, view switcher and the one primary action of a collection. */
export function PageHeader({ title, glyph, count, views, actions }: PageHeaderProps): ReactElement {
  return (
    <header className="flex flex-wrap items-center justify-between gap-12 pb-12 border-b border-border-subtle">
      <div className="flex items-center gap-8 min-w-0">
        {glyph ? <Icon name={glyph} color="var(--color-text-secondary)" /> : null}
        <h1 className="m-0 text-heading-16 font-semibold">{title}</h1>
        {count !== undefined ? (
          <span className="text-text-secondary tabular-nums">{count}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-8 print:hidden">
        {views}
        {actions}
      </div>
    </header>
  );
}
