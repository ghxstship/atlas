"use client";

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Returns a function that navigates to the current page with some query values changed. */
export function useQueryNav() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return (changes: Readonly<Record<string, string | null>>, replace = false) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    const href = (s ? `${pathname}?${s}` : pathname) as Route;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };
}
