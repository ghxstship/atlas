import type { SavedView } from "@xos/data/views";
import type { MenuItem } from "@xos/ui";
import type { Route } from "next";
import { viewToQuery } from "@/lib/views/query";
import type { ViewDraft, ViewsError } from "@/lib/views/actions";
import type { CollectionViewsProps } from "./collection-views";
import type * as Dialogs from "./view-dialogs";
import type { ViewDialogState } from "./view-dialogs";

/** Collections a saved view may share live; private.live_view_collections (3780) holds the same list. */
const LIVE_COLLECTIONS: ReadonlySet<string> = new Set([
  "project/schedule",
  "project/show",
  "show/run_of_show",
  "show/day_sheets",
]);

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** What the saved-views menu acts on, as CollectionViews holds it. */
export interface ViewMenuContext {
  readonly t: Translate;
  readonly org: string;
  readonly collection: string | null;
  readonly offered: readonly string[];
  readonly leading: CollectionViewsProps["leading"];
  readonly loadFailed: boolean;
  readonly views: readonly SavedView[] | null;
  readonly active: SavedView | null;
  readonly applied: string | null;
  readonly copyOf: string | undefined;
  readonly router: { push: (href: Route) => void };
  readonly go: (query: string) => void;
  readonly announce: (key: string, name?: string) => void;
  readonly run: (
    action: () => Promise<{ ok: true } | { ok: false; error: ViewsError }>,
    done: () => void,
  ) => Promise<boolean>;
  readonly draft: (name: string) => ViewDraft;
  readonly save: () => void;
  readonly setApplied: (id: string | null) => void;
  readonly setLive: (view: SavedView) => void;
  readonly setDialog: (dialog: ViewDialogState) => void;
  readonly viewDialogs: { load: () => Promise<typeof Dialogs> };
}

/**
 * The saved-views menu of CollectionViews (Section 11.15): the page's own views, the person's saved views, saving, the
 * update, default, live link, share and delete of the one open, and Manage. It loads when someone reaches for the
 * menu, so a collection page does not carry it (ADR 0027).
 */
export function viewMenuItems({
  t,
  org,
  collection,
  offered,
  leading,
  loadFailed,
  views,
  active,
  applied,
  copyOf,
  router,
  go,
  announce,
  run,
  draft,
  save,
  setApplied,
  setLive,
  setDialog,
  viewDialogs,
}: ViewMenuContext): MenuItem[] {
  const items: MenuItem[] = [];
  // Opening one of the page's views leaves the saved view the person had open.
  for (const item of leading?.items ?? []) {
    const { onSelect, label: name } = item;
    items.push(
      onSelect && name
        ? {
            ...item,
            onSelect: () => {
              setApplied(null);
              onSelect();
              announce("applied", name);
            },
          }
        : item,
    );
  }
  if (loadFailed) items.push({ heading: t("errors.loadFailed") });
  if (views === null) {
    if (!loadFailed) items.push({ heading: t("menu.loading") });
  } else if (views.length === 0) {
    items.push({ heading: t("menu.empty") });
  } else {
    items.push({ heading: t("menu.heading") });
    for (const v of views) {
      items.push({
        label: v.isDefault ? t("menu.default", { name: v.name }) : v.name,
        icon: v.shared || v.teamIds.length > 0 ? "Users" : "Bookmark",
        active: active?.id === v.id,
        onSelect: () => {
          setApplied(v.id);
          go(viewToQuery(v, offered));
          announce("applied", v.name);
        },
      });
    }
  }
  items.push({ separator: true });
  items.push({
    label: copyOf ? t("menu.saveCopy", { name: copyOf }) : t("menu.save"),
    icon: copyOf ? "Copy" : "BookmarkPlus",
    onSelect: save,
  });
  // After opening one of their views and changing the filters, the owner can update it to match.
  const differing = active ? undefined : views?.find((v) => v.id === applied && v.mine);
  if (differing) {
    items.push({
      label: t("menu.update", { name: differing.name }),
      icon: "RefreshCw",
      onSelect: () =>
        void run(
          () =>
            viewDialogs
              .load()
              .then((m) => m.updateViewAction(org, differing.id, draft(differing.name))),
          () => announce("updated", differing.name),
        ),
    });
  }
  if (active) {
    items.push(
      active.isDefault
        ? {
            label: t("menu.clearDefault", { name: active.name }),
            icon: "PinOff",
            onSelect: () =>
              void run(
                () =>
                  viewDialogs
                    .load()
                    .then((m) => m.setDefaultViewAction(org, collection ?? "", null)),
                () => announce("defaultCleared"),
              ),
          }
        : {
            label: t("menu.setDefault", { name: active.name }),
            icon: "Pin",
            onSelect: () =>
              void run(
                () =>
                  viewDialogs
                    .load()
                    .then((m) => m.setDefaultViewAction(org, collection ?? "", active.id)),
                () => announce("defaultSet", active.name),
              ),
          },
    );
    if (collection && LIVE_COLLECTIONS.has(collection)) {
      items.push({
        label: t("liveLink.menu", { name: active.name }),
        icon: "Radio",
        onSelect: () => setLive(active),
      });
    }
    if (active.mine) {
      items.push(
        {
          label: t("menu.share", { name: active.name }),
          icon: "Share2",
          onSelect: () => setDialog({ kind: "share", view: active }),
        },
        {
          label: t("menu.delete", { name: active.name }),
          icon: "Trash2",
          danger: true,
          onSelect: () => setDialog({ kind: "delete", view: active }),
        },
      );
    }
  }
  items.push({
    label: t("menu.manage"),
    icon: "Bookmark",
    onSelect: () => router.push(`/${org}/views` as Route),
  });
  return items;
}
