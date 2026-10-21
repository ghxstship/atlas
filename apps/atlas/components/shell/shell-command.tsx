"use client";

import { CommandMenu, type IconName } from "@xos/ui";
import { parseSearchQuery, type SearchToken } from "@xos/data/search-query";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
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

/** The operator hints shown before anything is typed (Section 11.7 Search). */
const OPERATORS = [
  { key: "type", insert: "type:" },
  { key: "project", insert: "project:" },
  { key: "assignee", insert: "assignee:me" },
  { key: "status", insert: "status:" },
  { key: "after", insert: "after:-7d" },
  { key: "due", insert: "due:<7d" },
  { key: "phrase", insert: '""' },
] as const;

/** Lowercase without accents, for comparing labels with what the person typed. */
function fold(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** True when every word appears in the text, ignoring case and accents. */
function matchesWords(text: string, words: readonly string[]): boolean {
  const haystack = fold(text);
  return words.every((word) => haystack.includes(fold(word)));
}

/** A token as the person typed it, for its chip. */
function tokenText(token: SearchToken): string {
  const minus = token.negated ? "-" : "";
  if (token.kind === "filter") return `${minus}${token.typed}:${token.value}`;
  return token.kind === "phrase" ? `${minus}"${token.text}"` : `${minus}${token.text}`;
}

/**
 * The shell's command menu (Cmd or Ctrl+K, and `/`). Before anything is typed it lists what the person
 * opened last (the last 50, Section 11.7), the common actions, the search operators, every page and the
 * help articles. As they type it shows the filters it recognized as chips and asks the server for records,
 * incidents, people, documents, SOPs, handbook articles, settings and actions (app.global_search, scoped by
 * row level security), so no org data is in the route bundle. Pages and the actions that open them show
 * the keys of their navigation shortcut. It works entirely from the keyboard: arrows move, Enter opens, an
 * operator hint fills the search field and keeps the menu open. It loads the first time it opens
 * (A24-009); the shell frame owns the shortcuts.
 */
export function ShellCommand({ open, onOpenChange, commands, locale, go }: ShellCommandProps) {
  const t = useTranslations();
  const pathname = usePathname();
  const search = useSearchParams();
  const org = pathname.split("/")[1] ?? "";
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer>({ query: "", groups: [] });
  const parsed = useMemo(() => parseSearchQuery(query), [query]);

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
        icon: item.icon as IconName,
        ...(item.code ? { code: item.code } : {}),
        ...(shortcut ? { shortcut } : {}),
        onSelect: () => {
          close();
          go(item.peek ? peekHref(item.peek) : (item.href ?? pathname));
        },
      };
    }),
  }));

  // Pages and help answer plain words in the browser; a query with operators asks only the server.
  const words = [...parsed.terms, ...parsed.phrases];
  const plain = parsed.tokens.every((tk) => tk.kind === "term" && !tk.negated);
  const keep = (label: string) => query.trim() === "" || (plain && matchesWords(label, words));
  const pages = commands
    .map((g) => ({
      label: g.label,
      items: g.items
        .filter((item) => keep(`${g.label} ${item.label}`))
        .map((item) => ({
          label: item.label,
          icon: item.icon as IconName,
          ...(item.shortcut ? { shortcut: item.shortcut } : {}),
          onSelect: () => {
            onOpenChange(false);
            go(item.href);
          },
        })),
    }))
    .filter((g) => g.items.length > 0);
  // A page whose name holds the whole query ("All Records") comes before the server's results, so Enter
  // opens it as it did when the menu listed pages alone; other matching pages follow the results.
  const phrase = fold(query.trim());
  const naming = (label: string) => phrase !== "" && fold(label).includes(phrase);
  const named = pages
    .map((g) => ({ ...g, items: g.items.filter((i) => naming(i.label)) }))
    .filter((g) => g.items.length > 0);
  const others = pages
    .map((g) => ({ ...g, items: g.items.filter((i) => !naming(i.label)) }))
    .filter((g) => g.items.length > 0);
  const help = helpCommandItems(locale).filter((a) => keep(a.title));
  const operators =
    query.trim() === ""
      ? [
          {
            label: t("shell.commandMenu.groups.operators"),
            items: OPERATORS.map((op) => ({
              label: t(`shell.commandMenu.operators.${op.key}`),
              code: op.insert,
              icon: "Filter" as IconName,
              keepOpen: true,
              onSelect: () => setQuery(op.key === "phrase" ? '"' : op.insert),
            })),
          },
        ]
      : [];

  const chips = parsed.tokens.filter((tk) => tk.kind !== "term" || tk.negated);
  const header =
    chips.length > 0 ? (
      <div
        role="status"
        aria-label={t("shell.commandMenu.filters")}
        className="flex flex-wrap items-center gap-4 px-16 py-8 border-b border-border-subtle text-text-12"
      >
        {chips.map((tk, index) => {
          const valid = tk.kind !== "filter" || tk.valid;
          const text = tokenText(tk);
          return (
            <span
              key={`${index}-${text}`}
              className={
                valid
                  ? "rounded-control border border-border-subtle bg-bg-hover px-8 py-2 font-mono text-text-primary"
                  : "rounded-control border border-danger px-8 py-2 text-danger-text"
              }
            >
              {valid ? text : t("shell.commandMenu.notUnderstood", { token: text })}
            </span>
          );
        })}
      </div>
    ) : null;

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
      header={header}
      placeholder={t("shell.chrome.searchHint")}
      groups={[
        ...named,
        ...found,
        ...operators,
        ...others,
        ...(help.length > 0
          ? [
              {
                label: t("help.title"),
                items: help.map((a) => ({
                  label: a.title,
                  icon: "BookOpen" as IconName,
                  onSelect: () => {
                    onOpenChange(false);
                    openHelpArticle(a.slug);
                  },
                })),
              },
            ]
          : []),
      ]}
    />
  );
}
