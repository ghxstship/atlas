"use client";

/** The docs sidebar, marking the item whose path best matches the current page. */
import { Sidebar } from "@xos/ui";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

export interface NavGroup {
  readonly label?: string;
  readonly items: readonly { readonly label: string; readonly href: string }[];
}

export function DocsSidebar({
  label,
  groups,
}: {
  label: string;
  groups: readonly NavGroup[];
}): ReactElement {
  const path = usePathname();
  let active: string | undefined;
  let best = -1;
  for (const group of groups) {
    for (const item of group.items) {
      const matches = path === item.href || path.startsWith(`${item.href}/`);
      if (matches && item.href.length > best) {
        best = item.href.length;
        active = item.label;
      }
    }
  }
  return (
    <Sidebar
      label={label}
      {...(active ? { active } : {})}
      groups={groups.map((g) => ({
        ...(g.label ? { label: g.label } : {}),
        items: g.items.map((i) => ({ label: i.label, href: i.href })),
      }))}
    />
  );
}
