"use client";

import { CommandMenu } from "@xos/ui";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { HELP_CONTENT } from "@/help/content.generated";
import { HELP_LOCALES, type HelpLocale } from "@/help/model";
import type { ShellNav } from "@/lib/shell/nav-model";
import { openHelpArticle } from "@/components/help/help-center";
import { searchCommandMenu, type CommandResultGroup } from "@/lib/shell/search-actions";
import { peekHref as shellPeekHref } from "@/lib/shell/peek";

/** Help articles for the command menu, in the person's locale. */
export function helpCommandItems(locale: string): { slug: string; title: string }[] {
  const lang: HelpLocale = (HELP_LOCALES as readonly string[]).includes(locale)
    ? (locale as HelpLocale)
    : "en-US";
  return [...HELP_CONTENT.articles[lang]]
    .sort((a, b) => a.order - b.order)
    .map((a) => ({ slug: a.slug, title: a.title }));
}

export interface ShellCommandProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: ShellNav["commands"];
  readonly locale: string;
  readonly go: (href: string) => void;
}

/** Results stay for the text they answer, so a slow answer never replaces a newer one. */
interface Answer {
  readonly query: string;
  readonly groups: readonly CommandResultGroup[];
}

/**
 * The shell's command menu (Cmd or Ctrl+K, and `/`, by default): common actions, records and incidents
 * by key or title, people, every page the person may open with the keys of its navigation shortcut, and
 * the help articles (Section 11.10 item 1, A59-015). Pages and help ship with the shell; actions, records
 * and people come from a server action as the person types, scoped by row level security, so no org data
 * is in the route bundle. It loads the first time it opens (A24-009); the shell frame owns the shortcuts.
 */
export function ShellCommand({ open, onOpenChange, commands, locale, go }: ShellCommandProps) {
  const t = useTranslations();
  const pathname = usePathname();
  const search = useSearchParams();
  const org = pathname.split("/")[1] ?? "";
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer>({ query: "", groups: [] });

  useEffect(() => {
    if (!open || org === "" || org === "auth" || org === "partner") return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        void searchCommandMenu({ org, query }).then((groups) => {
          if (live) setAnswer({ query, groups });
        });
      },
      query === "" ? 0 : 150,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, org, query]);

  const close = () => onOpenChange(false);
  // A peek where the shell opens it, else the record page (lib/shell/peek).
  const peekHref = (key: string) => shellPeekHref(org, pathname, search.toString(), key);
  // An action that opens a page shows that page's navigation shortcut, as the page entry does.
  const shortcutOf = new Map<string, string>(
    commands.flatMap((g) =>
      g.items.flatMap((i) => (i.shortcut ? [[i.href, i.shortcut] as const] : [])),
    ),
  );
  const found = answer.groups.map((g) => ({
    label: g.label,
    items: g.items.map((item) => {
      const shortcut = item.href === undefined ? undefined : shortcutOf.get(item.href);
      return {
        label: item.label,
        icon: item.icon,
        ...(item.code ? { code: item.code } : {}),
        ...(shortcut ? { shortcut } : {}),
        onSelect: () => {
          close();
          go(item.peek ? peekHref(item.peek) : (item.href ?? pathname));
        },
      };
    }),
  }));
  return (
    <CommandMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
      hotkey={false}
      placeholder={t("shell.chrome.searchHint")}
      onQueryChange={setQuery}
      groups={[
        ...found,
        ...commands.map((g) => ({
          label: g.label,
          items: g.items.map((item) => ({
            label: item.label,
            icon: item.icon,
            ...(item.shortcut ? { shortcut: item.shortcut } : {}),
            onSelect: () => {
              onOpenChange(false);
              go(item.href);
            },
          })),
        })),
        {
          label: t("help.title"),
          items: helpCommandItems(locale).map((a) => ({
            label: a.title,
            icon: "BookOpen",
            onSelect: () => {
              onOpenChange(false);
              openHelpArticle(a.slug);
            },
          })),
        },
      ]}
    />
  );
}
