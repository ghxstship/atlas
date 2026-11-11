"use client";

import type { Route } from "next";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { inSection } from "@/lib/localized";

/**
 * The console top bar (ia/sitemap.yaml chrome.topBar), marking the current section for assistive technology: the one
 * whose route, or a route below it, the page is on.
 */
export function ConsoleNav({
  label,
  items,
}: {
  label: string;
  /** `paths`: the item's route and the routes below it (lib/localized.ts sectionPaths). */
  items: readonly {
    readonly href: string;
    readonly label: string;
    readonly paths?: readonly string[];
  }[];
}) {
  const path = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="m-0 flex list-none flex-wrap gap-4 p-0">
        {items.map((item) => {
          const current = inSection(path, item.paths ?? [item.href]);
          return (
            <li key={item.href}>
              <NextLink
                href={item.href as Route}
                aria-current={current ? "page" : undefined}
                className={`inline-flex h-control-md items-center rounded-control px-8 text-text-13 font-medium ${
                  current
                    ? "bg-bg-raised text-text-primary"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {item.label}
              </NextLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
