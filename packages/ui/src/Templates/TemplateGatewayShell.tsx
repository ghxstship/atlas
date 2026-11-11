import type { ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type TemplateGatewayShellProps } from "./Templates.types.ts";

/** Every Gateway page: top navigation, no sidebar, comfortable density and 14 px base text. */
export function TemplateGatewayShell({
  topNav,
  aside,
  children,
  tabBar,
}: TemplateGatewayShellProps): ReactElement {
  return (
    <div
      data-template="gateway-shell"
      className="flex flex-col min-h-full max-md:flex-1 max-md:min-h-0 bg-bg-canvas text-text-14"
    >
      <div className="max-md:hidden">{topNav}</div>
      <main
        className={cx(
          "flex-1 p-24 max-md:p-16 min-w-0 max-md:min-h-0 max-md:overflow-y-auto",
          aside
            ? "grid grid-cols-[var(--ui-gateway-aside)_minmax(0,1fr)] max-lg:grid-cols-[minmax(0,1fr)] gap-24"
            : "flex flex-col gap-16",
        )}
      >
        {aside ? <div className="flex flex-col gap-16 min-w-0">{aside}</div> : null}
        <div className="flex flex-col gap-16 min-w-0">{children}</div>
      </main>
      {tabBar ? (
        <div data-xos-bottom-bar="" className="hidden max-md:block sticky bottom-0 [&_nav]:w-full">
          {tabBar}
        </div>
      ) : null}
    </div>
  );
}
