"use client";

import {
  CommandMenu,
  QuickAddChips,
  quickAddKey,
  useQuickAdd,
  type CommandItem,
  type QuickAddToken,
} from "@xos/ui";
import { defaultFilter } from "cmdk";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { QuickAddAlert, quickAddResolver, useQuickAddCopy } from "@/components/quick-add/shared";
import { quickAddRecordAction } from "@/lib/quick-add/actions";
import { quickAddInput } from "@/lib/quick-add/fields";
import { orderForPage, type CreateItem } from "@/lib/shell/create-order";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Quick add in the Create menu, for people who may create records: the org's zone for dates. */
export interface ShellQuickAdd {
  readonly org: string;
  readonly timeZone: string;
}

export interface ShellCreateProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly items: readonly CreateItem[];
  readonly pathname: string;
  readonly go: (href: string) => void;
  readonly quickAdd?: ShellQuickAdd | null | undefined;
}

/** The kind a Create menu line without /kind creates. */
const DEFAULT_KIND = "Task";

/**
 * The global Create menu (Section 4.10): what the person may create, the kinds made on the current
 * page first, so C then Enter starts this page's own create flow (Section 11.2). It loads the first
 * time it opens (A24-009) and shares the command menu's dialog; the shell frame owns the keys.
 *
 * Its search field is also the title field of a quick add (Section 11.7, ADR 0073). A line with a
 * date phrase, @person, #tag, /kind or ~scope shows its chips and one action, which creates the
 * record and opens it; a line that names no kind on the menu offers the same action. On a project's
 * pages the record lands in that project.
 */
export function ShellCreate({
  open,
  onOpenChange,
  items,
  pathname,
  go,
  quickAdd,
}: ShellCreateProps) {
  const t = useTranslations("shell.create");
  const tRoot = useTranslations() as unknown as Translate;
  const copy = useQuickAddCopy();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const projectKey = /^\/[^/]+\/p\/([A-Z]{2,5})(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const quick = useQuickAdd({
    text: quickAdd ? query : "",
    ...(quickAdd
      ? {
          timeZone: quickAdd.timeZone,
          resolve: quickAddResolver(quickAdd.org, {
            target: "record",
            where: { projectKey },
          }),
        }
      : {}),
  });
  const { here, rest } = orderForPage(items, pathname);

  const setOpen = (next: boolean) => {
    if (!next) {
      setQuery("");
      setError(null);
      quick.reset();
    }
    onOpenChange(next);
  };
  const entry = (item: CreateItem): CommandItem => ({
    label: item.label,
    icon: item.icon,
    onSelect: () => {
      setOpen(false);
      go(`${item.page}?create=1`);
    },
  });
  const groups = [
    ...(here.length > 0 ? [{ label: t("here"), items: here.map(entry) }] : []),
    ...(rest.length > 0
      ? [{ label: here.length > 0 ? t("more") : t("title"), items: rest.map(entry) }]
      : []),
  ];

  const add = async () => {
    if (!quickAdd || saving) return;
    setSaving(true);
    setError(null);
    try {
      const line = quickAddInput(await quick.finalize());
      const saved = await quickAddRecordAction(quickAdd.org, {
        projectKey,
        defaultKind: DEFAULT_KIND,
        kinds: null,
        title: line.title,
        kind: line.kind,
        personId: line.personId,
        tagId: line.tagId,
        scopeNodeId: line.scopeNodeId,
        when: line.when,
      });
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      setOpen(false);
      go(`/${quickAdd.org}/r/${encodeURIComponent(saved.data.key)}`);
    } finally {
      setSaving(false);
    }
  };

  // A removed chip leaves the search field focused, as the inline rows do.
  const dismiss = (token: QuickAddToken) => {
    quick.dismiss(token);
    document.querySelector<HTMLInputElement>("[cmdk-input]")?.focus();
  };

  const typed = query.trim();
  const tokens = quickAdd ? quick.parse.tokens : [];
  const kindToken = tokens.find((token) => token.type === "kind");
  const kind = kindToken ? quick.resolutions?.[quickAddKey(kindToken)] : undefined;
  const quickItem: CommandItem = {
    label: t("quickAdd.item", {
      title: quick.parse.title || tRoot("work.quickAdd.untitled"),
      kind: kind?.status === "resolved" ? kind.label : tRoot(`work.kinds.${DEFAULT_KIND}`),
    }),
    icon: "Plus",
    keepOpen: true,
    onSelect: () => void add(),
  };
  const quickGroup = [{ label: t("quickAdd.group"), items: [quickItem] }];
  // A line with tokens is a quick add; plain words still find kinds, and add a record only when no
  // kind matches them, so C, a kind's name and Enter open that kind's create flow as before.
  const matchesKind =
    typed !== "" &&
    groups.some((g) => g.items.some((i) => defaultFilter(`${g.label} ${i.label}`, typed) > 0));
  const quickOnly = tokens.length > 0;
  const quickLast = Boolean(quickAdd) && typed !== "" && !quickOnly && !matchesKind;

  return (
    <CommandMenu
      open={open}
      onOpenChange={setOpen}
      hotkey={false}
      label={t("title")}
      placeholder={t("prompt")}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setError(null);
      }}
      filter={!quickOnly}
      header={
        quickOnly || error ? (
          <div className="flex flex-col gap-8 px-16 py-8 border-b border-border-subtle">
            {quickOnly ? (
              <QuickAddChips
                parse={quick.parse}
                {...(quick.resolutions ? { resolutions: quick.resolutions } : {})}
                choices={quick.choices}
                onChoose={quick.choose}
                onDismiss={dismiss}
                copy={copy}
                labels={{
                  person: tRoot("work.quickAdd.types.person"),
                  tag: tRoot("work.quickAdd.types.tag"),
                  kind: tRoot("work.quickAdd.types.kind"),
                  scope: tRoot("work.quickAdd.types.scope"),
                  date: tRoot("work.quickAdd.types.date"),
                }}
              />
            ) : null}
            <QuickAddAlert error={error} />
          </div>
        ) : undefined
      }
      groups={quickOnly ? quickGroup : quickLast ? [...groups, ...quickGroup] : groups}
    />
  );
}
