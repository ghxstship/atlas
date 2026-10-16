"use client";

import { SegmentedControl } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";

/** Switches between the sections of a project tab with `?section=`, dropping the open peek. */
export function SectionTabs({
  label,
  current,
  options,
}: {
  label: string;
  current: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <SegmentedControl
      label={label}
      value={current}
      options={options}
      onChange={(next) => router.push(`${pathname}?section=${encodeURIComponent(next)}` as Route)}
    />
  );
}
