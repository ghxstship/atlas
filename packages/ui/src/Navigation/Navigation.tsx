import { useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Accordion as RAccordion, Direction, ToggleGroup } from "radix-ui";
import type {
  AccordionProps as ReferenceAccordionProps,
  BreadcrumbsProps as ReferenceBreadcrumbsProps,
  IconName,
  PaginationProps as ReferencePaginationProps,
  SegmentedControlProps as ReferenceSegmentedControlProps,
  SidebarProps as ReferenceSidebarProps,
  TabBarProps as ReferenceTabBarProps,
  TabsProps as ReferenceTabsProps,
  TopNavProps as ReferenceTopNavProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { rovingIndex, useControllable } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Badge } from "../Chips/Chips.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";

export type TabsProps = ReferenceTabsProps & {
  /** Panel content per tab value; each renders as a tabpanel labeled by its tab. */
  panels?: Record<string, ReactNode>;
};
export type SegmentedControlProps = ReferenceSegmentedControlProps;
export type AccordionProps = ReferenceAccordionProps;
export type BreadcrumbsProps = ReferenceBreadcrumbsProps;
export type PaginationProps = ReferencePaginationProps;

export interface NavItem {
  label: string;
  icon?: IconName;
  badge?: number;
  href?: string;
  onSelect?: () => void;
}
export type SidebarProps = Omit<ReferenceSidebarProps, "groups"> & {
  groups: { label?: string; collapsed?: boolean; items: NavItem[] }[];
};
export type TopNavProps = Omit<ReferenceTopNavProps, "items"> & {
  items: (NavItem & { icon: IconName })[];
  onSearch?: () => void;
  onHelp?: () => void;
  onAccount?: () => void;
};
export type TabBarProps = Omit<ReferenceTabBarProps, "items"> & {
  items: (NavItem & { icon: IconName })[];
};

/** Switches between sections of one object. Arrow keys move and select, Home and End jump. */
export function Tabs({ label, value, tabs, onChange, panels }: TabsProps): ReactElement {
  const base = useId().replace(/:/g, "");
  const dir = Direction.useDirection();
  const [current, setCurrent] = useControllable<string>(
    undefined,
    value ?? tabs[0]?.value ?? "",
    onChange,
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-16 max-w-full overflow-x-auto border-b border-border-subtle [scrollbar-width:none]"
      >
        {tabs.map((tab, i) => {
          const selected = tab.value === current;
          return (
            <button
              key={tab.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${i}`}
              aria-selected={selected}
              aria-controls={panels ? `${base}-panel-${i}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setCurrent(tab.value)}
              onKeyDown={(e) => {
                const next = rovingIndex(e.key, i, tabs.length, "horizontal", dir);
                if (next === null) return;
                e.preventDefault();
                const target = tabs[next];
                if (target) setCurrent(target.value);
                refs.current[next]?.focus();
              }}
              className={cx(
                "relative inline-flex flex-none items-center gap-6 py-8 bg-transparent border-0 whitespace-nowrap cursor-pointer",
                "font-medium text-text-13 text-text-secondary aria-selected:text-text-primary",
                "after:absolute after:inset-x-0 after:-bottom-(--stroke-width-hairline) after:h-(--stroke-width-focus) after:bg-transparent aria-selected:after:bg-accent",
                "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
              )}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span className="text-text-12 text-text-tertiary tabular-nums">{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {panels
        ? tabs.map((tab, i) => (
            <div
              key={tab.value}
              role="tabpanel"
              id={`${base}-panel-${i}`}
              aria-labelledby={`${base}-tab-${i}`}
              hidden={tab.value !== current}
              tabIndex={0}
              className="pt-16"
            >
              {panels[tab.value]}
            </div>
          ))
        : null}
    </div>
  );
}

/** Two to five peer options, such as the view switcher. Arrow keys move; one option is always on. */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps): ReactElement {
  const [current, setCurrent] = useControllable<string>(
    undefined,
    value ?? options[0]?.value ?? "",
    onChange,
  );
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={current}
      onValueChange={(next) => {
        if (next) setCurrent(next);
      }}
      className="inline-flex self-start max-w-full gap-2 p-2 rounded-control border border-border-control bg-bg-surface"
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cx(
            "inline-flex items-center gap-4 h-control-sm px-8 rounded-chip border-0 bg-transparent cursor-pointer",
            "font-medium text-text-12 text-text-secondary",
            "data-[state=on]:bg-bg-hover data-[state=on]:text-text-primary data-[state=on]:ring-(length:--stroke-width-hairline) data-[state=on]:ring-border-strong",
            "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
          )}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** Progressively discloses sections; each header is a button that Enter or Space toggles. */
export function Accordion({ items }: AccordionProps): ReactElement {
  return (
    <RAccordion.Root
      type="multiple"
      defaultValue={items.filter((it) => it.open).map((it) => it.title)}
      className="rounded-card border border-border-subtle"
    >
      {items.map((it) => (
        <RAccordion.Item
          key={it.title}
          value={it.title}
          className="group border-b border-border-subtle last:border-b-0"
        >
          <RAccordion.Header className="m-0">
            <RAccordion.Trigger
              className={cx(
                "flex items-center gap-6 w-full h-(--ui-accordion-row) px-12 bg-transparent border-0 cursor-pointer",
                "font-medium text-text-13 text-start pointer-coarse:min-h-target-coarse",
              )}
            >
              <Icon
                name="ChevronRight"
                size={14}
                className="text-text-secondary transition-transform duration-fast ease-standard group-data-[state=open]:rotate-90 group-data-[state=open]:rtl:-rotate-90"
              />
              <span>{it.title}</span>
              {it.meta ? (
                <span className="ms-auto text-text-secondary font-regular">{it.meta}</span>
              ) : null}
            </RAccordion.Trigger>
          </RAccordion.Header>
          <RAccordion.Content className="pb-12 ps-(--ui-accordion-indent) pe-12 text-text-secondary">
            {it.content}
          </RAccordion.Content>
        </RAccordion.Item>
      ))}
    </RAccordion.Root>
  );
}

/** Org, workspace, project, scope node, module and record; the last is the current page. */
export function Breadcrumbs({ items }: BreadcrumbsProps): ReactElement {
  const t = useT();
  return (
    <nav aria-label={t("nav.breadcrumb")}>
      <ol className="flex flex-wrap items-center gap-4 m-0 p-0 list-none text-text-13 text-text-secondary max-w-full">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${it.label}-${i}`} className="inline-flex items-center gap-4">
              {last ? (
                <span aria-current="page" className="text-text-primary">
                  {it.label}
                </span>
              ) : it.href ? (
                <a
                  href={it.href}
                  className="xos-hit text-inherit no-underline hover:text-text-primary"
                >
                  {it.label}
                </a>
              ) : (
                <span>{it.label}</span>
              )}
              {last ? null : (
                <span className="text-text-tertiary">
                  <Icon name="chevron-right" size={12} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Cursor paging: a summary and Previous and Next, never page numbers it cannot jump to. */
export function Pagination({
  summary,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: PaginationProps): ReactElement {
  const t = useT();
  return (
    <nav aria-label={t("nav.pagination")} className="flex flex-wrap items-center justify-end gap-8">
      <span className="text-text-secondary tabular-nums" aria-live="polite">
        {summary}
      </span>
      <Button size="sm" icon="ChevronLeft" disabled={!hasPrev} onClick={onPrev}>
        {t("nav.previous")}
      </Button>
      <Button size="sm" disabled={!hasNext} onClick={onNext}>
        {t("nav.next")}
        <Icon name="ChevronRight" size={14} />
      </Button>
    </nav>
  );
}

const navItemClass = cx(
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

/** The sitemap navigation. Group headings collapse and expand; the active item is the current page. */
export function Sidebar({ label, active, groups }: SidebarProps): ReactElement {
  const t = useT();
  const base = useId().replace(/:/g, "");
  const [collapsed, setCollapsed] = useState(() => groups.map((g) => g.collapsed ?? false));
  return (
    <nav
      aria-label={label ?? t("nav.main")}
      className="w-(--layout-sidebar) max-w-full p-8 box-border bg-bg-surface border border-border-subtle rounded-card print:hidden"
    >
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
                  <NavLink item={item} active={item.label === active} className={navItemClass} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** The Gateway top bar on desktop: brand, the five destinations, search, help and the account menu. */
export function TopNav({
  brand,
  label,
  person,
  active,
  items,
  onSearch,
  onHelp,
  onAccount,
}: TopNavProps): ReactElement {
  const t = useT();
  return (
    <header
      className={cx(
        "flex items-center justify-between gap-16 h-(--ui-topnav) px-20 max-lg:px-16 bg-bg-surface border-b border-border-subtle",
        "print:hidden",
      )}
    >
      <div className="flex items-center gap-24 max-lg:gap-12 min-w-0">
        <span className="max-lg:[&_[aria-hidden]+[aria-hidden]]:hidden">
          <BrandMark name={brand} size="sm" />
        </span>
        <nav
          aria-label={label}
          className="min-w-0 overflow-x-auto max-md:hidden [scrollbar-width:none]"
        >
          <ul className="flex gap-4 m-0 p-0 list-none">
            {items.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href ?? "#"}
                  aria-current={item.label === active ? "page" : undefined}
                  onClick={item.onSelect}
                  className={cx(
                    "inline-flex items-center gap-6 h-row-default px-12 max-lg:px-8 rounded-control no-underline",
                    "font-medium text-text-14 text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                    "aria-[current=page]:bg-bg-hover aria-[current=page]:text-text-primary",
                    "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
                  )}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                  {item.badge ? (
                    <Badge
                      count={item.badge}
                      tone="accent"
                      label={t("tabbar.badge", { n: item.badge })}
                    />
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="flex flex-none items-center gap-8">
        <IconButton icon="Search" label={t("command.label")} shortcut="⌘ K" onClick={onSearch} />
        <IconButton icon="CircleHelp" label={t("help.title")} shortcut="?" onClick={onHelp} />
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={t("nav.account", { name: person })}
          onClick={onAccount}
          className="xos-hit grid place-items-center size-(--ui-avatar-lg) p-0 rounded-full border-0 bg-transparent cursor-pointer"
        >
          <span aria-hidden="true" className="contents">
            <Avatar name={person} />
          </span>
        </button>
      </div>
    </header>
  );
}

/** The five-destination bottom bar for phones; targets meet touch-min (48 pt). */
export function TabBar({
  label,
  items,
  active,
  compass = false,
  centerLabel,
}: TabBarProps): ReactElement {
  const t = useT();
  return (
    <nav
      aria-label={label}
      className={cx(
        "flex justify-around items-stretch w-(--ui-tabbar) max-w-full pt-6 pb-20 box-border bg-bg-surface border-t border-border-subtle",
        compass && "xos-compass",
      )}
    >
      {items.map((item) => {
        const center = item.label === centerLabel;
        return (
          <a
            key={item.label}
            href={item.href ?? "#"}
            aria-current={item.label === active ? "page" : undefined}
            onClick={item.onSelect}
            className={cx(
              "flex flex-1 flex-col items-center justify-center gap-2 min-h-touch-min rounded-control no-underline",
              "text-text-11 font-medium text-text-secondary aria-[current=page]:text-accent-text",
            )}
          >
            <span
              className={cx(
                "relative inline-flex",
                center &&
                  "p-8 -mt-20 rounded-full bg-accent text-accent-text-on ring-(length:--space-4) ring-bg-surface",
              )}
            >
              <Icon name={item.icon} size={compass ? 24 : 20} />
              {item.badge ? (
                <Badge
                  count={item.badge}
                  tone="danger"
                  label={t("tabbar.badge", { n: item.badge })}
                  className="absolute -top-6 -end-12"
                />
              ) : null}
            </span>
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
