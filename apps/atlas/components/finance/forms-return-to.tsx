"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * The page a recording returns to: this one, with some query values changed. The action redirects there itself, because
 * the sheet holding this form can leave in the same commit as the refresh, and an effect inside it would never run. So
 * the sheet's flags clear and `?notice=` arrives with the new page, even when the recording empties the list.
 */
export function ReturnTo({ changes }: { changes: Readonly<Record<string, string | null>> }) {
  const pathname = usePathname();
  const next = new URLSearchParams(useSearchParams().toString());
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return <input type="hidden" name="returnTo" value={query ? `${pathname}?${query}` : pathname} />;
}
