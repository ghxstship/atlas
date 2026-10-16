"use client";

import { SegmentedControl } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface CollectionViewOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The view switcher of every Gateway collection (Section 11.15), ported from Atlas's A31
 * CollectionViews: the design system's segmented control offering only the views the sitemap lists
 * for the page. Switching replaces the `view` query parameter and keeps every other one, so filters
 * survive and the URL opens the same screen. Saved views stay in Atlas: they belong to an org
 * membership, and an external party has none.
 */
export function CollectionViews({
  label,
  value,
  options,
}: {
  label: string;
  value: string;
  options: readonly CollectionViewOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  if (options.length < 2) return null;
  return (
    <SegmentedControl
      label={label}
      value={value}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
      onChange={(view) => {
        const next = new URLSearchParams(search.toString());
        next.set("view", view);
        router.replace(`${pathname}?${next.toString()}` as Route, { scroll: false });
      }}
    />
  );
}
