"use client";

import type { MenuItem } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import type { Bulk } from "@/components/bulk/use-bulk";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import { GATEWAY_ACTIONS } from "@/lib/bulk/catalog";

/** The menu itself (Radix's dropdown) loads the first time a row's menu opens (ADR 0027). */
const menuModule = onDemand(() => import("./row-menu"));

type Translate = (key: string, values?: Record<string, string>) => string;

interface Target {
  readonly items: MenuItem[];
  readonly label: string;
  readonly at: { x: number; y: number };
  readonly cell: HTMLElement;
}

/** What a row's menu can do: open its page, copy its link, select it, take the list's action on it. */
export interface RowActions {
  readonly id: string;
  /** The row's name in the menu's label, such as a document's title. */
  readonly label: string;
  /** The row's page, for Open and Copy link. */
  readonly href?: string;
  readonly bulk?: Bulk;
  /** Whether the list's action applies to this row (a document waiting for a signature). */
  readonly eligible?: boolean;
}

/**
 * Context menus on Gateway rows (Section 11.7, ADR 0082), as Atlas's useRowMenu: right-click,
 * Shift+F10 or the Context Menu key on a row of a DataTable offers the row's actions, the same ones
 * its page and the bulk bar offer. Pass `open` to the table's `onRowContextMenu` with the row's
 * actions; render `menu` after the table.
 */
export function useRowMenu(): {
  open: (actions: RowActions, at: { x: number; y: number } | null, cell: HTMLElement) => void;
  menu: ReactNode;
} {
  const t = useTranslations("gateway.collections.menu") as unknown as Translate;
  const actionCopy = useTranslations("gateway.collections.actions") as unknown as Translate;
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const loaded = useOnDemand(menuModule, target !== null);
  const open = useCallback(
    (actions: RowActions, at: { x: number; y: number } | null, cell: HTMLElement) => {
      const items: MenuItem[] = [];
      if (actions.href) {
        const href = actions.href;
        items.push({
          label: t("open"),
          icon: "ExternalLink",
          onSelect: () => router.push(href as Route),
        });
        items.push({
          label: t("copyLink"),
          icon: "Link2",
          onSelect: () =>
            void navigator.clipboard?.writeText(new URL(href, window.location.href).href),
        });
      }
      const bulk = actions.bulk;
      if (bulk?.selection && bulk.action) {
        const action = GATEWAY_ACTIONS[bulk.action];
        if (items.length > 0) items.push({ separator: true });
        items.push({
          label: bulk.isSelected(actions.id) ? t("deselect") : t("select"),
          icon: "SquareCheck",
          shortcut: "X",
          onSelect: () => bulk.toggle(actions.id),
        });
        if (actions.eligible) {
          items.push({
            label: actionCopy(`${action.id}.one`),
            icon: action.icon,
            onSelect: () => bulk.act(actions.id),
          });
        }
      }
      if (items.length === 0) return;
      const rect = cell.getBoundingClientRect();
      setTarget({
        items,
        label: t("label", { row: actions.label }),
        at: at ?? { x: rect.left, y: rect.bottom },
        cell,
      });
    },
    [t, actionCopy, router],
  );
  return {
    open,
    menu: loaded && target ? <loaded.RowMenu {...target} onClose={() => setTarget(null)} /> : null,
  };
}
