"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export interface ProjectTabGroup {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly { readonly id: string; readonly label: string; readonly href: string }[];
}

/**
 * The project tab bar (Section 4.5.4): tabs in sitemap order, grouped by act. The current tab is
 * marked for assistive technology, and the scope filter in the query string follows the person
 * from tab to tab. The bar scrolls sideways below `lg` instead of wrapping.
 */
export function ProjectTabs({
  label,
  groups,
}: {
  label: string;
  groups: readonly ProjectTabGroup[];
}) {
  const pathname = usePathname();
  const scope = useSearchParams().get("scope");
  const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto border-b border-border-subtle">
      <ul className="m-0 flex list-none items-end gap-16 px-4 p-0">
        {groups.map((group) => (
          <li key={group.id} className="flex shrink-0 flex-col gap-2">
            <span className="text-text-11 font-medium uppercase tracking-wide text-text-tertiary">
              {group.label}
            </span>
            <ul className="m-0 flex list-none gap-2 p-0">
              {group.tabs.map((tab) => {
                const current = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
                return (
                  <li key={tab.id}>
                    <Link
                      href={`${tab.href}${suffix}` as Route}
                      aria-current={current ? "page" : undefined}
                      className={`flex min-h-row-default items-center whitespace-nowrap border-b-2 px-8 text-text-13 hover:text-text-primary ${
                        current
                          ? "border-accent font-medium text-text-primary"
                          : "border-transparent text-text-secondary"
                      }`}
                    >
                      {tab.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
