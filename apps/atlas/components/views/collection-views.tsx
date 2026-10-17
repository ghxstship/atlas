"use client";

import type { SavedView, Team } from "@xos/data/views";
import {
  Button,
  Checkbox,
  Dialog,
  DropdownMenu,
  Input,
  SegmentedControl,
  type MenuItem,
} from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  deleteViewAction,
  loadViewsAction,
  saveViewAction,
  setDefaultViewAction,
  shareViewAction,
  updateViewAction,
  type ViewDraft,
  type ViewsError,
} from "@/lib/views/actions";
import {
  canonicalQuery,
  collectionKeyFor,
  currentQuery,
  isBareQuery,
  queryToView,
  viewToQuery,
} from "@/lib/views/query";

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
}

type Dialogs =
  | { readonly kind: "save" }
  | { readonly kind: "share"; readonly view: SavedView }
  | { readonly kind: "delete"; readonly view: SavedView }
  | null;

/**
 * The one view switcher of every Atlas collection (Section 11.15): the views that fit the data, and
 * the person's saved views of the page. A saved view is the page's query string (view, filters, sort,
 * grouping, search), so switching view type keeps the filters, and opening a saved view lands on the
 * same screen a link would. Views are saved per person, shared with the org or with teams, and one can
 * open by default on the page; a shared view shows each viewer only what their own access allows.
 * Drop-in for the SegmentedControl a page used before: the same label, value, options and onChange.
 */
export function CollectionViews({ label, value, options, onChange }: CollectionViewsProps) {
  const t = useTranslations("views") as unknown as Translate;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const org = pathname.split("/").filter(Boolean)[0] ?? "";
  const collection = collectionKeyFor(pathname);
  const offered = useMemo(() => options.map((o) => o.value), [options]);
  const [views, setViews] = useState<readonly SavedView[] | null>(null);
  const [teams, setTeams] = useState<readonly Team[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [applied, setApplied] = useState<string | null>(null);
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

  const showError = useCallback(
    (code: ViewsError | "loadFailed") => setError(t(`errors.${code}`)),
    [t],
  );

  const accept = useCallback(
    (result: Awaited<ReturnType<typeof loadViewsAction>>) => {
      if (!result.ok) {
        showError("loadFailed");
        return null;
      }
      setViews(result.data.views);
      setTeams(result.data.teams);
      return result.data.views;
    },
    [showError],
  );

  const reload = useCallback(async () => {
    if (!collection || !org) return null;
    return accept(await loadViewsAction(org, collection));
  }, [collection, org, accept]);

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
        if (live) showError("loadFailed");
      },
    );
    return () => {
      live = false;
    };
  }, [collection, org, accept, go, offered, showError]);

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
    const result = await action();
    if (!result.ok) {
      showError(result.error);
      return false;
    }
    done();
    await reload();
    return true;
  };

  const items: MenuItem[] = [];
  if (views === null) {
    items.push({ heading: t("menu.loading") });
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
          () => updateViewAction(org, differing.id, draft(differing.name)),
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
                () => setDefaultViewAction(org, collection ?? "", null),
                () => announce("defaultCleared"),
              ),
          }
        : {
            label: t("menu.setDefault", { name: active.name }),
            icon: "Pin",
            onSelect: () =>
              void run(
                () => setDefaultViewAction(org, collection ?? "", active.id),
                () => announce("defaultSet", active.name),
              ),
          },
    );
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
        <DropdownMenu
          label={active ? active.name : t("menu.label")}
          icon="Bookmark"
          items={items}
        />
      ) : null}
      <p role="status" className="sr-only">
        {status}
      </p>
      {error ? (
        <p role="alert" className="m-0 basis-full text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
      {dialog?.kind === "save" ? (
        <SaveDialog
          teams={teams}
          onClose={() => setDialog(null)}
          onSave={(name, share) =>
            run(
              () => saveViewAction(org, collection ?? "", draft(name), share),
              () => announce("saved", name),
            )
          }
        />
      ) : null}
      {dialog?.kind === "share" ? (
        <ShareDialog
          view={dialog.view}
          teams={teams}
          onClose={() => setDialog(null)}
          onShare={(share) =>
            run(
              () => shareViewAction(org, dialog.view.id, share),
              () => announce("shared", dialog.view.name),
            )
          }
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={t("delete.title", { name: dialog.view.name })}
          description={t("delete.description")}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>{t("delete.cancel")}</Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const name = dialog.view.name;
                  const deleted = await run(
                    () => deleteViewAction(org, dialog.view.id),
                    () => announce("deleted", name),
                  );
                  if (deleted) {
                    setDialog(null);
                    go(new URLSearchParams({ view: value }).toString());
                  }
                }}
              >
                {t("delete.submit")}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : null}
    </div>
  );
}

interface Share {
  readonly org: boolean;
  readonly teamIds: readonly string[];
}

function ShareChoices({
  teams,
  value,
  onChange,
}: {
  teams: readonly Team[];
  value: Share;
  onChange: (share: Share) => void;
}) {
  const t = useTranslations("views.share") as unknown as Translate;
  const id = useId();
  return (
    <div className="flex flex-col gap-8">
      <Checkbox
        label={t("everyone")}
        checked={value.org}
        onChange={(e) => onChange({ ...value, org: e.target.checked })}
      />
      <fieldset
        aria-describedby={teams.length === 0 ? `${id}-none` : undefined}
        className="m-0 flex flex-col gap-8 border-0 p-0"
      >
        <legend className="mt-8 p-0 text-text-12 font-medium text-text-secondary">
          {t("teams")}
        </legend>
        {teams.length === 0 ? (
          <p id={`${id}-none`} className="m-0 text-text-12 text-text-secondary">
            {t("noTeams")}
          </p>
        ) : (
          teams.map((team) => (
            <Checkbox
              key={team.id}
              label={team.name}
              checked={value.teamIds.includes(team.id)}
              onChange={(e) =>
                onChange({
                  ...value,
                  teamIds: e.target.checked
                    ? [...value.teamIds, team.id]
                    : value.teamIds.filter((x) => x !== team.id),
                })
              }
            />
          ))
        )}
      </fieldset>
    </div>
  );
}

function SaveDialog({
  teams,
  onClose,
  onSave,
}: {
  teams: readonly Team[];
  onClose: () => void;
  onSave: (name: string, share: Share) => Promise<boolean>;
}) {
  const t = useTranslations("views.save") as unknown as Translate;
  const formId = useId();
  const [name, setName] = useState("");
  const [share, setShare] = useState<Share>({ org: false, teamIds: [] });
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      description={t("description")}
      actions={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-12"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() === "") {
            setMissing(true);
            return;
          }
          setBusy(true);
          const saved = await onSave(name.trim(), share);
          setBusy(false);
          if (saved) onClose();
        }}
      >
        <Input
          label={t("name")}
          value={name}
          maxLength={100}
          placeholder={t("nameHint")}
          help={t("nameHelp")}
          {...(missing ? { error: t("nameRequired") } : {})}
          onChange={(e) => {
            setName(e.target.value);
            setMissing(false);
          }}
          autoFocus
        />
        <ShareChoices teams={teams} value={share} onChange={setShare} />
      </form>
    </Dialog>
  );
}

export function ShareDialog({
  view,
  teams,
  onClose,
  onShare,
}: {
  view: SavedView;
  teams: readonly Team[];
  onClose: () => void;
  onShare: (share: Share) => Promise<boolean>;
}) {
  const t = useTranslations("views.share") as unknown as Translate;
  const [share, setShare] = useState<Share>({ org: view.shared, teamIds: view.teamIds });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: view.name })}
      description={t("description")}
      actions={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const done = await onShare(share);
              setBusy(false);
              if (done) onClose();
            }}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      <ShareChoices teams={teams} value={share} onChange={setShare} />
    </Dialog>
  );
}
