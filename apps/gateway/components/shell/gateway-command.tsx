"use client";

import { CommandMenu, type IconName } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { searchGateway, type SearchResultGroup } from "@/lib/shell/search-actions";
import type { FrameLink } from "./gateway-frame";

type Translate = (key: string, values?: Record<string, string>) => string;

/** Results stay with the text they answer, so a slow answer never replaces a newer one. */
interface Answer {
  readonly query: string;
  readonly groups: readonly SearchResultGroup[];
}

/** Lowercase without accents, for comparing page names with what the person typed. */
function fold(text: string): string {
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
}

export interface GatewayCommandProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: readonly FrameLink[];
  readonly go: (href: string) => void;
}

/**
 * Gateway's command menu (Cmd or Ctrl+K, Section 11.10 item 1, A126). Before anything is typed it lists
 * every page the person can open. As they type, pages whose names hold the words stay, and the server
 * (lib/shell/search-actions.ts) adds the matching actions, the person's own documents, conversations,
 * engagements and opportunities, and settings. When a page's name holds the whole query the pages come
 * first, that page leading, so Enter opens it as before; otherwise the server's results lead. It loads with the shell overlays, the
 * first time one opens, so cmdk and the search stay out of every page's JavaScript.
 */
export function GatewayCommand({ open, onOpenChange, commands, go }: GatewayCommandProps) {
  const t = useTranslations() as unknown as Translate;
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer>({ query: "", groups: [] });

  useEffect(() => {
    const text = query.trim();
    if (!open || text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchGateway({ query: text }).then(
        (groups) => {
          if (live) setAnswer({ query: text, groups });
        },
        () => {
          if (live) setAnswer({ query: text, groups: [] });
        },
      );
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const text = query.trim();
  const words = text.split(/\s+/).filter((w) => w !== "" && !w.startsWith("-"));
  const phrase = fold(text);
  const pages = commands.filter(
    (c) => text === "" || words.every((w) => fold(c.label).includes(fold(w.replace(/"/g, "")))),
  );
  const naming = pages.filter((c) => phrase !== "" && fold(c.label).includes(phrase));
  const others = pages.filter((c) => !naming.includes(c));
  const pageItem = (c: FrameLink) => ({
    label: c.label,
    icon: c.icon as IconName,
    onSelect: () => go(c.href),
  });
  const found = (answer.query === text && text.length >= 2 ? answer.groups : []).map((g) => ({
    label: g.label,
    items: g.items.map((item) => ({
      label: item.label,
      icon: item.icon as IconName,
      onSelect: () => go(item.href),
    })),
  }));
  // The pages move as one group, so its label appears once: first when a page names the query, else last.
  const pageGroup =
    pages.length > 0
      ? [{ label: t("gateway.shell.commandGroup"), items: [...naming, ...others].map(pageItem) }]
      : [];

  return (
    <CommandMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
      hotkey={false}
      filter={false}
      query={query}
      onQueryChange={setQuery}
      placeholder={t("gatewaySearch.menuHint")}
      groups={naming.length > 0 ? [...pageGroup, ...found] : [...found, ...pageGroup]}
    />
  );
}
