"use client";

import { Icon } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IntentLink } from "@/components/shell/intent-link";
import { fit } from "./tab-fit";

export interface ProjectTabGroup {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly { readonly id: string; readonly label: string; readonly href: string }[];
}

interface FlatTab {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly group: string;
  readonly index: number;
}

const tabClass = (current: boolean) =>
  `flex min-h-row-default items-center whitespace-nowrap border-b-2 px-8 text-text-13 hover:text-text-primary ${
    current
      ? "border-accent font-medium text-text-primary"
      : "border-transparent text-text-secondary"
  }`;

/**
 * The project tab bar (Section 4.5.4): tabs in sitemap order, grouped by act. The current tab is
 * marked for assistive technology, and the scope filter in the query string follows the person
 * from tab to tab. Tabs that do not fit the bar's width collect under a More button at its end, a
 * disclosure listing them by group; the current tab always stays in the bar, taking the last slot
 * when it would otherwise overflow (A59-003). More opens with Enter or Space, and Escape, a click
 * outside or leaving it with Tab closes it. A tab, in the bar or under More, prefetches when the
 * person points at or focuses it: prefetching all of them on every project page cost about 18 KB of
 * script and a server render per tab (gate 10).
 */
export function ProjectTabs({
  label,
  moreLabel,
  moreName,
  groups,
}: {
  label: string;
  /** The More button's visible text, and its accessible name ("More tabs"). */
  moreLabel: string;
  moreName: string;
  groups: readonly ProjectTabGroup[];
}) {
  const pathname = usePathname();
  const scope = useSearchParams().get("scope");
  const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const panelId = useId();
  const nav = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);

  const flat = useMemo<FlatTab[]>(() => {
    let index = 0;
    return groups.flatMap((g) => g.tabs.map((tab) => ({ ...tab, group: g.id, index: index++ })));
  }, [groups]);
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const current = flat.findIndex((tab) => isCurrent(tab.href));
  const labelsKey = flat.map((tab) => tab.label).join("|");

  // Widths measured once per set of labels with every tab rendered; resizes reuse them.
  const measured = useRef<{
    key: string;
    edges: number[];
    widths: number[];
    more: number;
    /** What the rendered bar needed beyond its measured widths. */
    reserve: number;
  } | null>(null);
  const [shown, setShown] = useState<{ key: string; count: number } | null>(null);
  const count = shown?.key === labelsKey ? shown.count : null;
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  // A web font that arrives after the first measure widens the tabs without resizing the bar, so its widths are stale:
  // they measure again, with every tab rendered, before the next paint.
  useEffect(() => {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts) return undefined;
    let live = true;
    const again = () => {
      if (!live) return;
      measured.current = null;
      setShown(null);
    };
    fonts.addEventListener("loadingdone", again);
    // A font can finish between the first measure and this effect, which no event would report.
    void fonts.ready.then(again);
    return () => {
      live = false;
      fonts.removeEventListener("loadingdone", again);
    };
  }, []);

  useLayoutEffect(() => {
    const bar = nav.current;
    const row = list.current;
    if (!bar || !row) return undefined;
    const measure = () => {
      const cache = measured.current;
      if (cache?.key !== labelsKey) {
        if (count !== null) return;
        const rtl = getComputedStyle(row).direction === "rtl";
        const start = row.getBoundingClientRect();
        const tabs = [...row.querySelectorAll<HTMLElement>("[data-tab]")];
        measured.current = {
          key: labelsKey,
          edges: tabs.map((el) => {
            const r = el.getBoundingClientRect();
            return rtl ? start.right - r.left : r.right - start.left;
          }),
          widths: tabs.map((el) => el.getBoundingClientRect().width),
          more: moreButton.current?.getBoundingClientRect().width ?? 0,
          reserve: 0,
        };
      }
      const m = measured.current;
      if (!m) return;
      const next = fit(m.edges, m.widths, bar.clientWidth - m.reserve, m.more, current);
      setShown((old) =>
        old?.key === labelsKey && old.count === next ? old : { key: labelsKey, count: next },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [labelsKey, count, current]);

  // The measured widths leave out what the bar renders around its tabs (group headings, a promoted tab's group), so
  // after each fit anything past the bar's clip edge is reserved and the tabs fit again. The reserve only grows until
  // the next measure, so this settles.
  useLayoutEffect(() => {
    const m = measured.current;
    const bar = nav.current;
    const row = list.current;
    if (count === null || count === 0 || !m || m.key !== labelsKey || !bar || !row) return;
    const rtl = getComputedStyle(row).direction === "rtl";
    const edge = bar.getBoundingClientRect();
    let over = 0;
    for (const el of row.children) {
      const r = el.getBoundingClientRect();
      over = Math.max(over, rtl ? edge.left - r.left : r.right - edge.right);
    }
    if (over <= 0.5) return;
    m.reserve += Math.ceil(over);
    const next = fit(m.edges, m.widths, bar.clientWidth - m.reserve, m.more, current);
    if (next !== count) setShown({ key: labelsKey, count: next });
  }, [count, labelsKey, current]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !nav.current?.contains(target)) setOpenOn(null);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const limit = count ?? flat.length;
  const inBar = (tab: FlatTab) => tab.index < limit || tab.index === current;
  const overflow = flat.filter((tab) => !inBar(tab));
  // Until the first measure every tab renders (so it can be measured) beside the More button.
  const showMore = count === null || overflow.length > 0;

  const link = (tab: FlatTab, className: string) => (
    <IntentLink
      href={`${tab.href}${suffix}` as Route}
      aria-current={isCurrent(tab.href) ? "page" : undefined}
      className={className}
    >
      {tab.label}
    </IntentLink>
  );

  return (
    <nav
      ref={nav}
      aria-label={label}
      className="relative -mx-4 overflow-x-clip border-b border-border-subtle"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpenOn(null);
          moreButton.current?.focus();
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (open && next && !event.currentTarget.contains(next)) setOpenOn(null);
      }}
    >
      <ul ref={list} className="m-0 flex list-none items-end gap-16 px-4 p-0">
        {groups.map((group) => {
          const tabs = flat.filter((tab) => tab.group === group.id && inBar(tab));
          if (tabs.length === 0) return null;
          return (
            <li key={group.id} className="flex shrink-0 flex-col gap-2">
              <span className="text-text-11 font-medium uppercase tracking-wide text-text-tertiary">
                {group.label}
              </span>
              <ul className="m-0 flex list-none gap-2 p-0">
                {tabs.map((tab) => (
                  <li key={tab.id} data-tab="">
                    {link(tab, tabClass(tab.index === current))}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
        {showMore ? (
          <li className={`relative shrink-0 ${count === null ? "invisible" : ""}`}>
            <button
              ref={moreButton}
              type="button"
              aria-label={moreName}
              title={moreName}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpenOn(open ? null : pathname)}
              className={`${tabClass(false)} cursor-pointer gap-4 border-x-0 border-t-0 bg-transparent`}
            >
              {moreLabel}
              <Icon name="ChevronDown" size={14} />
            </button>
          </li>
        ) : null}
      </ul>
      {open ? (
        <div
          id={panelId}
          className="absolute end-4 top-full z-popover mt-4 flex min-w-(--ui-menu-min) flex-col gap-8 rounded-card bg-bg-raised p-8 shadow-menu forced-colors:border"
        >
          {groups.map((group) => {
            const tabs = overflow.filter((tab) => tab.group === group.id);
            if (tabs.length === 0) return null;
            return (
              <div key={group.id} className="flex flex-col gap-2">
                <span className="px-8 text-text-11 font-medium uppercase tracking-wide text-text-tertiary">
                  {group.label}
                </span>
                <ul className="m-0 flex list-none flex-col p-0">
                  {tabs.map((tab) => (
                    <li key={tab.id}>
                      {link(
                        tab,
                        "flex min-h-row-default items-center rounded-control px-8 text-text-13 text-text-primary no-underline hover:bg-bg-hover",
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </nav>
  );
}
