"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, type ReactNode } from "react";
import type { BulkConfig, BulkRowRef } from "@/components/bulk/types";
import { useBulk, type Bulk } from "@/components/bulk/use-bulk";
import { useHoverCards } from "@/components/hover/use-hover-cards";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { useQueryNav } from "./kit-use-query-nav";
import { type ListItem } from "./kit.types";

/**
 * What the table, list and board views share for their rows (Section 11.7): the selection and bulk
 * bar, the row menu (Open, Open full page, Copy link, Select, Change) and the hover card on the parts
 * that name a row (`columns`), read from the page's list items. On a page with no record panel
 * (`activatable={false}`) the menu offers no Open; with no full page (`fullPage={false}`, saved reports)
 * it offers Open without Open full page.
 */
export function useItemActions({
  refs,
  previews,
  columns,
  bulk,
  activatable,
  fullPage = true,
}: {
  /** Each row's id and the name its menu and refusals use. */
  refs: readonly BulkRowRef[];
  /** The rows as list items, for their hover cards. */
  previews: readonly ListItem[] | undefined;
  /** The `data-column` parts that preview a row. */
  columns: readonly string[];
  bulk: BulkConfig | null | undefined;
  activatable: boolean;
  fullPage?: boolean;
}): {
  bulk: Bulk;
  menuFor: (id: string, at: { x: number; y: number } | null, element: HTMLElement) => void;
  hoverProps: ReturnType<typeof useHoverCards>["hoverProps"];
  /** The bulk bar, the open menu and the hover card, rendered after the view. */
  after: ReactNode;
} {
  const go = useQueryNav();
  const pathname = usePathname();
  const search = useSearchParams();
  const kit = useBulk(bulk, refs);
  const rowMenu = useRowMenu();
  const labels = useMemo(() => new Map(refs.map((r) => [r.id, r.label])), [refs]);
  const items = useMemo(() => new Map((previews ?? []).map((p) => [p.id, p])), [previews]);
  const fullHref = (id: string) => {
    const q = new URLSearchParams(search.toString());
    q.set("peek", id);
    q.set("full", "1");
    return `${pathname}?${q.toString()}`;
  };
  const hover = useHoverCards((id, column) => {
    const item = items.get(id);
    if (!item || !columns.includes(column)) return null;
    return {
      kind: "record",
      recordKey: item.recordKey,
      title: item.title,
      state: item.state,
      stateLabel: item.stateLabel,
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.next ? { next: item.next } : {}),
    };
  });
  return {
    bulk: kit,
    menuFor: (id, at, element) =>
      rowMenu.open(
        {
          id,
          label: labels.get(id) ?? id,
          ...(activatable ? { open: () => go({ peek: id }) } : {}),
          ...(activatable && fullPage ? { href: fullHref(id) } : {}),
          bulk: kit,
        },
        at,
        element,
      ),
    hoverProps: hover.hoverProps,
    after: (
      <>
        {kit.bar}
        {rowMenu.menu}
        {hover.card}
      </>
    ),
  };
}
