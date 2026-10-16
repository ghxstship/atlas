"use client";

import { ActivityFeedItem, PresenceIndicator, SegmentedControl, TemplateSplitView } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Client pieces of the workforce pages (A29): the view and section switchers that keep the rest of
 * the query string, and the @xos/ui components the server pages render directly.
 */

export { ActivityFeedItem, PresenceIndicator, TemplateSplitView };

/** A segmented switch that sets one query key, dropping the open peek. */
export function QuerySwitch({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <SegmentedControl
      label={label}
      value={value}
      options={options}
      onChange={(next) => {
        const q = new URLSearchParams(params.toString());
        q.set(name, next);
        q.delete("peek");
        q.delete("full");
        q.delete("create");
        router.replace(`${pathname}?${q.toString()}` as Route, { scroll: false });
      }}
    />
  );
}
