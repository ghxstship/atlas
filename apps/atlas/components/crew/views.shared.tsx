"use client";

import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Client views for the People and Crew collections. Every view keeps the page's query string, so
 * filters, sort and grouping survive a view switch (Section 11.15), and opening a row sets
 * `?peek=<id>` so the side peek is linkable and the Back button closes it.
 */

export function useQueryHref() {
  const pathname = usePathname();
  const search = useSearchParams();
  return (changes: Readonly<Record<string, string | null>>) => {
    const q = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    return (s ? `${pathname}?${s}` : pathname) as Route;
  };
}
