"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, type ReactNode } from "react";
import type { RowActions } from "./use-row-menu";
import type { RowMenuRequest } from "./row-menu-host";

/** useRowMenu itself, its copy and the menu load on the first right-click (A24-009, ADR 0027). */
const RowMenuHost = dynamic(() => import("./row-menu-host").then((m) => m.RowMenuHost));

/**
 * useRowMenu for a page at the edge of its route budget (the Projects table): the same `open` and
 * `menu`, but the code that builds a row's menu loads the first time one opens, not with the page.
 * The first menu waits for that fetch; every later one opens as useRowMenu's does.
 */
export function useRowMenuOnDemand(): {
  open: (actions: RowActions, at: { x: number; y: number } | null, cell: HTMLElement) => void;
  menu: ReactNode;
} {
  const [request, setRequest] = useState<RowMenuRequest | null>(null);
  const open = useCallback(
    (actions: RowActions, at: { x: number; y: number } | null, cell: HTMLElement) =>
      setRequest((last) => ({ actions, at, cell, seq: (last?.seq ?? 0) + 1 })),
    [],
  );
  return { open, menu: request ? <RowMenuHost request={request} /> : null };
}
