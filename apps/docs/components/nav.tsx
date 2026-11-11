"use client";

/** The docs sidebar, marking the item whose path best matches the current page. */
import { Sidebar } from "@xos/ui";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { activeNavLabel, type NavGroup } from "@/lib/nav-active.ts";

export type { NavGroup };

export function DocsSidebar({
  label,
  groups,
}: {
  label: string;
  groups: readonly NavGroup[];
}): ReactElement {
  const active = activeNavLabel(usePathname(), groups);
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
