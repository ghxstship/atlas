"use client";

import { ContextMenu, type MenuItem } from "@xos/ui";

/** A row's menu at the pointer or the focused cell, loaded on demand by useRowMenu. */
export function RowMenu({
  items,
  label,
  at,
  cell,
  onClose,
}: {
  items: MenuItem[];
  label: string;
  at: { x: number; y: number };
  cell: HTMLElement;
  onClose: () => void;
}) {
  return <ContextMenu label={label} items={items} at={at} returnFocus={cell} onClose={onClose} />;
}
