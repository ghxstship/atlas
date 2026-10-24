import { useId, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type NavItem, type SidebarProps } from "./Navigation.types.ts";

/** One sidebar item, for lists built beside the Sidebar (the Atlas Favorites, which reorder). */
export const sidebarItemClass = cx(
  "flex items-center gap-8 w-full h-control-md px-8 rounded-control border-0 bg-transparent box-border",
  "font-medium text-text-13 text-text-secondary text-start no-underline cursor-pointer",
  "hover:bg-bg-hover hover:text-text-primary aria-[current=page]:bg-bg-hover aria-[current=page]:text-text-primary",
  "pointer-coarse:min-h-target-coarse",
);

function NavLink({
  item,
  active,
  className,
}: {
  item: NavItem;
  active: boolean;
  className: string;
}) {
  const body = (
    <>
      {item.icon ? <Icon name={item.icon} /> : null}
      <span className="flex-1 min-w-0 truncate">{item.label}</span>
      {item.badge !== undefined ? (
        <span className="text-text-11 text-text-secondary tabular-nums">{item.badge}</span>
      ) : null}
    </>
  );
  const current = active ? ("page" as const) : undefined;
  return item.href ? (
    <a href={item.href} aria-current={current} className={className} onClick={item.onSelect}>
      {body}
    </a>
  ) : (
    <button type="button" aria-current={current} className={className} onClick={item.onSelect}>
      {body}
    </button>
  );
}

/** The sidebar's frame, for lists built beside the Sidebar so they match it. */
export const sidebarClass =
  "w-(--layout-sidebar) max-w-full p-8 box-border bg-bg-surface border border-border-subtle rounded-card print:hidden";

/**
 * The sitemap navigation. Group headings collapse and expand; the active item is the current page. An item may list
 * items under it (the recent projects under Projects), indented one step.
 */
export function Sidebar({ label, active, groups }: SidebarProps): ReactElement {
  const t = useT();
  const base = useId().replace(/:/g, "");
  const [collapsed, setCollapsed] = useState(() => groups.map((g) => g.collapsed ?? false));
  return (
    <nav aria-label={label ?? t("nav.main")} className={sidebarClass}>
      {groups.map((g, gi) => {
        const isCollapsed = collapsed[gi] ?? false;
        const listId = `${base}-group-${gi}`;
        return (
          <div key={`${g.label ?? "group"}-${gi}`} className={g.label ? "mt-12" : undefined}>
            {g.label ? (
              <h2 className="m-0 mb-2">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={listId}
                  onClick={() => setCollapsed((c) => c.map((v, i) => (i === gi ? !v : v)))}
                  className={cx(
                    "flex items-center gap-4 w-full px-8 py-2 bg-transparent border-0 cursor-pointer",
                    "text-text-11 font-medium text-text-secondary hover:text-text-primary pointer-coarse:min-h-target-coarse",
                  )}
                >
                  <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={12} />
                  {g.label}
                </button>
              </h2>
            ) : null}
            <ul id={listId} hidden={isCollapsed} className="m-0 p-0 list-none">
              {g.items.map((item) => (
                <li key={item.label}>
                  <NavLink
                    item={item}
                    active={item.label === active}
                    className={sidebarItemClass}
                  />
                  {item.items && item.items.length > 0 ? (
                    <ul
                      aria-label={item.itemsLabel}
                      data-sidebar-subitems=""
                      className="m-0 ps-16 py-0 pe-0 list-none"
                    >
                      {item.items.map((child) => (
                        <li key={`${child.label}-${child.href ?? ""}`}>
                          <NavLink
                            item={child}
                            active={child.label === active}
                            className={sidebarItemClass}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
