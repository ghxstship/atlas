"use client";

import type { SavedView, Team } from "@xos/data/views";
import { SegmentedControl, type MenuItem } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadViewsAction, type ViewDraft, type ViewsError } from "@/lib/views/actions";
import {
  canonicalQuery,
  collectionKeyFor,
  currentQuery,
  isBareQuery,
  queryToView,
  viewToQuery,
} from "@/lib/views/query";
import { DeferredDropdownMenu } from "@/components/shell/deferred-menus";
import type { ViewDialogState } from "./view-dialogs";
import { CollectionExport } from "./collection-export";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import dynamic from "next/dynamic";
import type { FilterField } from "./filter-model";
import { useCustomFieldList } from "@/components/custom-fields/list";
import type { CustomFieldListView } from "@/lib/custom-fields/types";

/** The save, share and delete dialogs, and the writes, load when one is used (A24-009). */
const viewDialogs = onDemand(() => import("./view-dialogs"));

/** The live link dialog (P1, ADR 0130) loads when someone shares a view live. */
const liveLinkDialog = onDemand(() => import("./live-link-dialog"));

/** Collections a saved view may share live; private.live_view_collections (2780) holds the same list. */
const LIVE_COLLECTIONS: ReadonlySet<string> = new Set([
  "project/schedule",
  "project/show",
  "show/run_of_show",
  "show/day_sheets",
]);

/** The Add filter control loads on a page that has something to filter by, not with every collection (A24-009). */
const CollectionFilters = dynamic(() => import("./filter-bar").then((m) => m.CollectionFilters));

/** Copy lookups take built keys (`status.saved`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface CollectionViewOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: string;
}

export interface CollectionViewsProps {
  /** Accessible name of the view switcher, such as "Shipment views". */
  readonly label: string;
  /** The view on screen. */
  readonly value: string;
  /** Only the views that fit the data (Section 11.15); a switcher never shows a disabled option. */
  readonly options: readonly CollectionViewOption[];
  /** How the page switches view; by default the `view` query parameter is replaced. */
  readonly onChange?: (view: string) => void;
  /**
   * Fields the page declares for the Add filter control (A117), which the page matches itself on what it
   * shows (`f.<key>` conditions). The org's filterable custom fields come from the surrounding
   * CustomFieldList.
   */
  readonly fields?: readonly FilterField[];
  /** The page's filterable custom fields, when it hands them over instead of a CustomFieldList. */
  readonly customFields?: CustomFieldListView | null;
}

type Dialogs = ViewDialogState | null;

const NO_FIELDS: readonly FilterField[] = [];

/**
 * The one view switcher of every Atlas collection (Section 11.15): the views that fit the data, and
 * the person's saved views of the page. A saved view is the page's query string (view, filters, sort,
 * grouping, search), so switching view type keeps the filters, and opening a saved view lands on the
 * same screen a link would. Views are saved per person, shared with the org or with teams, and one can
 * open by default on the page; a shared view shows each viewer only what their own access allows.
 * Beside them, the Add filter control (A117) writes conditions into the query, so saved views keep them.
 * Drop-in for the SegmentedControl a page used before: the same label, value, options and onChange.
 */
export function CollectionViews({
  label,
  value,
  options,
  onChange,
  fields = NO_FIELDS,
  customFields,
}: CollectionViewsProps) {
  const t = useTranslations("views") as unknown as Translate;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const surrounding = useCustomFieldList();
  // The control shows only where there is something to filter by, as filter-bar.tsx decides on its targets.
  const filterable =
    fields.length > 0 ||
    ((customFields === undefined ? surrounding : customFields)?.fields ?? []).some(
      (f) => f.filterable,
    );
  const org = pathname.split("/").filter(Boolean)[0] ?? "";
  const collection = collectionKeyFor(pathname);
  const offered = useMemo(() => options.map((o) => o.value), [options]);
  const [views, setViews] = useState<readonly SavedView[] | null>(null);
  const [teams, setTeams] = useState<readonly Team[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A failed load shows in the menu, which retries when it opens. It never adds a line to the page
  // header after the page has painted: that pushed the whole collection down (CLS, gate 10).
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [live, setLive] = useState<SavedView | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const dialogsModule = useOnDemand(viewDialogs, dialog !== null);
  const liveModule = useOnDemand(liveLinkDialog, live !== null);
  const appliedDefault = useRef(false);

  const go = useCallback(
    (query: string) =>
      router.replace((query ? `${pathname}?${query}` : pathname) as Route, { scroll: false }),
    [router, pathname],
  );
  const switchView = (view: string) => {
    if (onChange) {
      onChange(view);
      return;
    }
    const next = new URLSearchParams(search.toString());
    next.set("view", view);
    for (const key of ["peek", "full"]) next.delete(key);
    go(next.toString());
  };

  const showError = useCallback((code: ViewsError) => setError(t(`errors.${code}`)), [t]);

  const failLoad = useCallback(() => {
    setLoadFailed(true);
    setStatus(t("errors.loadFailed"));
  }, [t]);

  const accept = useCallback(
    (result: Awaited<ReturnType<typeof loadViewsAction>>) => {
      if (!result.ok) {
        failLoad();
        return null;
      }
      setLoadFailed(false);
      setViews(result.data.views);
      setTeams(result.data.teams);
      return result.data.views;
    },
    [failLoad],
  );

  const reload = useCallback(async () => {
    if (!collection || !org) return null;
    return loadViewsAction(org, collection).then(accept, () => {
      failLoad();
      return null;
    });
  }, [collection, org, accept, failLoad]);

  /** Opening the menu after a failed load tries again, as the failure message says. */
  const retryLoad = () => {
    if (!loadFailed) return;
    setLoadFailed(false);
    void reload();
  };

  // Load once per page; open the person's default when the URL carries no collection state.
  useEffect(() => {
    if (!collection || !org) return;
    let live = true;
    loadViewsAction(org, collection).then(
      (result) => {
        if (!live) return;
        const loaded = accept(result);
        if (!loaded || appliedDefault.current) return;
        appliedDefault.current = true;
        const preferred = loaded.find((v) => v.isDefault);
        if (preferred && isBareQuery(new URLSearchParams(window.location.search))) {
          setApplied(preferred.id);
          go(viewToQuery(preferred, offered));
        }
      },
      () => {
        if (live) failLoad();
      },
    );
    return () => {
      live = false;
    };
  }, [collection, org, accept, go, offered, failLoad]);

  const here = currentQuery(new URLSearchParams(search.toString()), value, offered);
  const active = views?.find((v) => canonicalQuery(viewToQuery(v, offered)) === here) ?? null;
  const draft = (name: string): ViewDraft =>
    ({
      name,
      ...queryToView(new URLSearchParams(search.toString()), value),
    }) as ViewDraft;

  const announce = (key: string, name?: string) =>
    setStatus(t(`status.${key}`, name === undefined ? {} : { name }));

  const run = async (
    action: () => Promise<{ ok: true } | { ok: false; error: ViewsError }>,
    done: () => void,
  ) => {
    setError(null);
    const result = await action().catch(() => ({
      ok: false as const,
      error: "unexpected" as const,
    }));
    if (!result.ok) {
      showError(result.error);
      return false;
    }
    done();
    await reload();
    return true;
  };

  const items: MenuItem[] = [];
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
    label: t("menu.save"),
    icon: "BookmarkPlus",
    onSelect: () => setDialog({ kind: "save" }),
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

  return (
    <div className="flex flex-wrap items-center gap-8">
      {options.length > 1 ? (
        <SegmentedControl
          label={label}
          value={value}
          options={options.map((o) => ({
            value: o.value,
            label: o.label,
            ...(o.icon ? { icon: o.icon } : {}),
          }))}
          onChange={switchView}
        />
      ) : null}
      {collection ? (
        <DeferredDropdownMenu
          label={active ? active.name : t("menu.label")}
          icon="Bookmark"
          items={items}
          onOpen={retryLoad}
        />
      ) : null}
      <CollectionExport />
      <p role="status" className="sr-only">
        {status}
      </p>
      {error ? (
        <p role="alert" className="m-0 basis-full text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
      {filterable ? (
        <CollectionFilters
          search={search}
          fields={fields}
          {...(customFields !== undefined ? { customFields } : {})}
          onNavigate={go}
          {...(collection && !active ? { onSave: () => setDialog({ kind: "save" }) } : {})}
        />
      ) : null}
      {live && liveModule ? (
        <liveModule.LiveLinkDialog
          org={org}
          view={live}
          projectKey={
            pathname.split("/").filter(Boolean)[1] === "p"
              ? (pathname.split("/").filter(Boolean)[2] ?? null)
              : null
          }
          onClose={() => setLive(null)}
        />
      ) : null}
      {dialog && dialogsModule ? (
        <dialogsModule.ViewDialog
          dialog={dialog}
          teams={teams}
          onClose={() => setDialog(null)}
          onSave={(name, share) =>
            run(
              () => dialogsModule.saveViewAction(org, collection ?? "", draft(name), share),
              () => announce("saved", name),
            )
          }
          onShare={(view, share) =>
            run(
              () => dialogsModule.shareViewAction(org, view.id, share),
              () => announce("shared", view.name),
            )
          }
          onDelete={async (view) => {
            const deleted = await run(
              () => dialogsModule.deleteViewAction(org, view.id),
              () => announce("deleted", view.name),
            );
            if (deleted) {
              setDialog(null);
              go(new URLSearchParams({ view: value }).toString());
            }
          }}
        />
      ) : null}
    </div>
  );
}
