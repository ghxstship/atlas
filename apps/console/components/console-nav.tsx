"use client";

import type { Route } from "next";
import NextLink from "next/link";
import { usePathname } from "next/navigation";

/** The console top bar (ia/sitemap.yaml chrome.topBar), marking the current section for assistive technology. */
export function ConsoleNav({
  label,
  items,
}: {
  label: string;
  items: readonly { readonly href: string; readonly label: string }[];
}) {
  const path = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="m-0 flex list-none flex-wrap gap-4 p-0">
        {items.map((item) => {
          const current = path === item.href || path.startsWith(`${item.href}/`);
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
