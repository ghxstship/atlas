"use client";

import { IconButton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
import { useRowMenu } from "@/components/menus/use-row-menu";

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * A record page's title row (Section 11.7): right-click on it, Shift+F10 or the Context Menu key
 * inside it, or its menu button offers the record's menu as its rows do in every view: Copy link
 * and, for people who may change records, Change state, owner or phase through the bulk RPC.
 */
export function RecordTitleRow({
  org,
  recordId,
  recordKey,
  bulk,
  children,
}: {
  org: string;
  recordId: string;
  recordKey: string;
  bulk: BulkConfig | null;
  children: ReactNode;
}) {
  const t = useTranslations("collab.menu") as unknown as Translate;
  const rows = useMemo(() => [{ id: recordId, label: recordKey }], [recordId, recordKey]);
  const kit = useBulk(bulk, rows, { toolbar: false });
  const rowMenu = useRowMenu();
  const open = (at: { x: number; y: number } | null, element: HTMLElement) =>
    rowMenu.open(
      {
        id: recordId,
        label: recordKey,
        href: `/${org}/r/${encodeURIComponent(recordKey)}`,
        onPage: true,
        bulk: kit,
      },
      at,
      element,
    );
  return (
    <div
      data-record-title-row
      onContextMenu={(e) => {
        e.preventDefault();
        open({ x: e.clientX, y: e.clientY }, e.target as HTMLElement);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
          e.preventDefault();
          open(null, e.target as HTMLElement);
        }
      }}
      className="flex flex-wrap items-center gap-8 text-text-secondary"
    >
      {children}
      <IconButton
        icon="Ellipsis"
        label={t("label", { row: recordKey })}
        aria-haspopup="menu"
        onClick={(e) => open(null, e.currentTarget)}
      />
      {rowMenu.menu}
      {kit.bar}
    </div>
  );
}
