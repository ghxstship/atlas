"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { DeferredDropdownMenu } from "./deferred-menus";

/** One secondary action: a page to open, or a panel the owning component opens. */
export interface MoreAction {
  readonly label: string;
  readonly href?: string;
  readonly onSelect?: () => void;
  readonly disabled?: boolean;
}

/**
 * The secondary actions of a toolbar or page header in one "More" menu, so the screen keeps to the five-action
 * toolbar budget (gate 27). The menu is the @xos/ui DropdownMenu, deferred: its closed trigger renders without
 * Radix, and pointing at it loads the menu (ADR 0027).
 */
export function MoreActions({
  label,
  items,
}: {
  label: string;
  items: readonly (MoreAction | null | false)[];
}) {
  const router = useRouter();
  const shown = items.filter((item): item is MoreAction => Boolean(item));
  if (shown.length === 0) return null;
  return (
    <DeferredDropdownMenu
      label={label}
      items={shown.map((item) => ({
        label: item.label,
        ...(item.disabled ? { disabled: true } : {}),
        onSelect: () => {
          if (item.href !== undefined) router.push(item.href as Route);
          else item.onSelect?.();
        },
      }))}
    />
  );
}
