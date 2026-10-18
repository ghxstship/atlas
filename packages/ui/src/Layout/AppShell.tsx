import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type AppShellProps } from "./Layout.types.ts";

/**
 * Brand slot, sidebar, header and content for every Atlas page. Below lg the sidebar becomes a drawer
 * opened from the header menu button and closed by Esc or the scrim; below md the bottom bar shows.
 */
export function AppShell({
  brand,
  sidebar,
  header,
  children,
  mobileNav,
}: AppShellProps): ReactElement {
  const t = useT();
  const sideId = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div
      data-open={open ? "true" : undefined}
      className={cx(
        "group/shell relative grid grid-cols-[var(--layout-sidebar)_minmax(0,1fr)] max-lg:grid-cols-[minmax(0,1fr)]",
        "min-h-(--ui-shell-min) h-full overflow-hidden bg-bg-canvas print:block",
      )}
    >
      <div
        id={sideId}
        className={cx(
          "flex flex-col gap-4 min-h-0 p-8 overflow-y-auto bg-bg-surface border-e border-border-subtle [&>*]:shrink-0",
          "[&_nav]:border-0 [&_nav]:p-0 [&_nav]:w-auto print:hidden",
          "max-lg:hidden max-lg:group-data-[open=true]/shell:flex max-lg:group-data-[open=true]/shell:absolute",
          "max-lg:inset-y-0 max-lg:start-0 max-lg:z-sidebar max-lg:w-[min(var(--layout-sidebar),85%)] max-lg:shadow-dialog",
        )}
      >
        {brand ? <div className="px-8 pt-4 pb-8">{brand}</div> : null}
        {sidebar}
      </div>
      {open ? (
        <button
          type="button"
          aria-label={t("action.close")}
          onClick={() => setOpen(false)}
          className={cx(
            "hidden max-lg:block absolute inset-0 z-[calc(var(--z-sidebar)-1)] p-0 border-0 cursor-pointer",
            "bg-scrim opacity-scrim-dark in-data-[theme=light]:opacity-scrim-light in-data-[theme=sunlight]:opacity-scrim-light",
          )}
        />
      ) : null}
      <main className="flex flex-col min-w-0 min-h-0">
        <div
          className={cx(
            "flex items-center justify-between gap-8 h-(--ui-shell-head) px-16 border-b border-border-subtle",
            "max-lg:justify-start",
            !header && "hidden max-lg:flex",
          )}
        >
          <span className="hidden max-lg:inline-flex">
            <button
              ref={menuButton}
              type="button"
              aria-label={t("shell.menu")}
              title={t("shell.menu")}
              aria-expanded={open}
              aria-controls={sideId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center justify-center h-control-md min-w-control-md rounded-control border border-transparent bg-transparent text-text-secondary cursor-pointer hover:bg-bg-hover pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse"
            >
              <Icon name="Menu" />
            </button>
          </span>
          {header ? (
            <div className="flex flex-1 items-center justify-between gap-8 min-w-0">{header}</div>
          ) : null}
        </div>
        <div
          data-xos-bottom-bar-scroll={mobileNav ? "" : undefined}
          className="flex flex-col gap-16 min-h-0 px-24 py-16 max-lg:p-16 overflow-y-auto [&>*]:shrink-0"
        >
          {children}
        </div>
        {mobileNav ? (
          <div
            data-xos-bottom-bar=""
            className="hidden max-md:block sticky bottom-0 [&_nav]:w-full print:hidden"
          >
            {mobileNav}
          </div>
        ) : null}
      </main>
    </div>
  );
}
