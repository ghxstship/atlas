"use client";

import type { MenuItem } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import type { Bulk } from "@/components/bulk/use-bulk";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

/** The menu itself (Radix's dropdown) loads the first time a row's menu opens (ADR 0027). */
const menuModule = onDemand(() => import("./row-menu"));

type Translate = (key: string, values?: Record<string, string>) => string;

interface Target {
  readonly items: MenuItem[];
  readonly label: string;
  readonly at: { x: number; y: number };
  readonly cell: HTMLElement;
}

/** What a row's menu can do: open it, open it as a page, copy its link, select it, change it. */
export interface RowActions {
  readonly id: string;
  /** The row's name in the menu's label, such as its key. */
  readonly label: string;
  readonly open?: () => void;
  /** The row's full page, for Open as a page and Copy link. */
  readonly href?: string;
  readonly bulk?: Bulk;
  /** The row's own actions after the changes, the ones its peek offers, such as Delete draft. */
  readonly more?: readonly MenuItem[];
}

/**
 * Context menus on rows (Section 11.7): right-click, Shift+F10 or the Context Menu key on a row of a
 * DataTable offers the row's actions, the same ones its peek and the bulk bar offer. Pass `open` to
 * the table's `onRowContextMenu` with the row's actions; render `menu` after the table.
 */
export function useRowMenu(): {
  open: (actions: RowActions, at: { x: number; y: number } | null, cell: HTMLElement) => void;
  menu: ReactNode;
} {
  const t = useTranslations("collab.menu") as unknown as Translate;
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const loaded = useOnDemand(menuModule, target !== null);
  const open = useCallback(
    (actions: RowActions, at: { x: number; y: number } | null, cell: HTMLElement) => {
      const items: MenuItem[] = [];
      if (actions.open) items.push({ label: t("open"), icon: "Eye", onSelect: actions.open });
      if (actions.href) {
        const href = actions.href;
        items.push({
          label: t("openFull"),
          icon: "Maximize2",
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
      if (bulk?.selection) {
        items.push({ separator: true });
        items.push({
          label: bulk.isSelected(actions.id) ? t("deselect") : t("select"),
          icon: "SquareCheck",
          shortcut: "X",
          onSelect: () => bulk.toggle(actions.id),
        });
        for (const field of bulk.fieldsFor(actions.id).slice(0, 4)) {
          items.push({
            label: t("change", { field: field.label }),
            icon: "PenLine",
            onSelect: () => bulk.edit(field, actions.id),
          });
        }
      }
      if (actions.more && actions.more.length > 0) {
        if (items.length > 0) items.push({ separator: true });
        items.push(...actions.more);
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
    [t, router],
  );
  return {
    open,
    menu: loaded && target ? <loaded.RowMenu {...target} onClose={() => setTarget(null)} /> : null,
  };
}
