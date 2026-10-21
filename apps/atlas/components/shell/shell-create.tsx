"use client";

import { CommandMenu } from "@xos/ui";
import { useTranslations } from "next-intl";
import { orderForPage, type CreateItem } from "@/lib/shell/create-order";

export interface ShellCreateProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly items: readonly CreateItem[];
  readonly pathname: string;
  readonly go: (href: string) => void;
}

/**
 * The global Create menu (Section 4.10): what the person may create, the kinds made on the current
 * page first, so C then Enter starts this page's own create flow (Section 11.2). It loads the first
 * time it opens (A24-009) and shares the command menu's dialog; the shell frame owns the keys.
 */
export function ShellCreate({ open, onOpenChange, items, pathname, go }: ShellCreateProps) {
  const t = useTranslations("shell.create");
  const { here, rest } = orderForPage(items, pathname);
  const entry = (item: CreateItem) => ({
    label: item.label,
    icon: item.icon,
    onSelect: () => {
      onOpenChange(false);
      go(`${item.page}?create=1`);
    },
  });
  return (
    <CommandMenu
      open={open}
      onOpenChange={onOpenChange}
      hotkey={false}
      label={t("title")}
      placeholder={t("prompt")}
      groups={[
        ...(here.length > 0 ? [{ label: t("here"), items: here.map(entry) }] : []),
        ...(rest.length > 0
          ? [{ label: here.length > 0 ? t("more") : t("title"), items: rest.map(entry) }]
          : []),
      ]}
    />
  );
}
