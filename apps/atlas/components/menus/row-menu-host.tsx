"use client";

import { useEffect } from "react";
import { useRowMenu, type RowActions } from "./use-row-menu";

/** One request to open a row's menu; `seq` tells a second right-click on the same row apart. */
export interface RowMenuRequest {
  readonly actions: RowActions;
  readonly at: { x: number; y: number } | null;
  readonly cell: HTMLElement;
  readonly seq: number;
}

/** Opens useRowMenu's menu for each request, loaded on demand by useRowMenuOnDemand. */
export function RowMenuHost({ request }: { request: RowMenuRequest }) {
  const { open, menu } = useRowMenu();
  useEffect(() => {
    open(request.actions, request.at, request.cell);
  }, [open, request]);
  return menu;
}
