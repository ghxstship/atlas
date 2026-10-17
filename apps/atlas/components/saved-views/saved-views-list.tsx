"use client";

import type { SavedView, Team } from "@xos/data/views";
import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { ShareDialog } from "@/components/views/collection-views";
import {
  deleteViewAction,
  renameViewAction,
  shareViewAction,
  type ViewsResult,
} from "@/lib/views/actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A saved view with the page it opens on already named by the server. */
export interface SavedViewItem {
  readonly view: SavedView;
  /** "Opens on All projects", or the sentence for a page the viewer cannot open. */
  readonly page: string;
}

/** The `views.types` key of a stored view type: "Resource Schedule" is `resource-schedule`. */
function typeKey(viewType: string): string {
  const key = viewType.toLowerCase().replaceAll(" ", "-");
  return key === "split-view" ? "split" : key;
}

type Dialogs =
  | { readonly kind: "rename"; readonly view: SavedView }
  | { readonly kind: "share"; readonly view: SavedView }
  | { readonly kind: "delete"; readonly view: SavedView }
  | null;

/**
 * The viewer's saved views (Section 11.15): their own, which they rename, share by the view share
 * rules (the org, teams) or delete, and the views others shared with them. Each name opens the view
 * on its collection's page.
 */
export function SavedViewsList({
  org,
  mine,
  shared,
  teams,
}: {
  org: string;
  mine: readonly SavedViewItem[];
  shared: readonly SavedViewItem[];
  teams: readonly Team[];
}) {
  const t = useTranslations("savedViews") as unknown as Translate;
  const v = useTranslations("views") as unknown as Translate;
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<ViewsResult>, done: string): Promise<boolean> => {
    setError(null);
    const result = await action();
    if (!result.ok) {
      setError(v(`errors.${result.error}`));
      return false;
    }
    setStatus(done);
    router.refresh();
    return true;
  };

  const audience = (view: SavedView) => {
    const teamsCount = view.teamIds.length;
    if (view.shared && teamsCount > 0) return t("audience.orgAndTeams", { count: teamsCount });
    if (view.shared) return t("audience.org");
    if (teamsCount > 0) return t("audience.teams", { count: teamsCount });
    return t("audience.private");
  };

  const section = (id: string, heading: string, items: readonly SavedViewItem[], empty: string) => (
    <section aria-labelledby={id} className="flex max-w-layout-form flex-col gap-8">
      <h2 id={id} className="m-0 text-label-14 font-semibold text-text-primary">
        {heading}
      </h2>
      {items.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {items.map(({ view, page }) => (
            <li key={view.id} className="flex flex-wrap items-center justify-between gap-8 p-12">
              <span className="flex min-w-0 flex-col gap-2">
                <Link
                  href={`/${org}/views/${view.id}` as Route}
                  className="text-text-14 font-medium text-accent-text underline-offset-2 hover:underline"
                >
                  {view.name}
                </Link>
                <span className="text-text-12 text-text-secondary">
                  {[page, v(`types.${typeKey(view.viewType)}`)]
                    .concat(view.mine ? [audience(view)] : [])
                    .concat(view.isDefault ? [t("isDefault")] : [])
                    .join(" · ")}
                </span>
              </span>
              {view.mine ? (
                <span className="flex flex-wrap gap-8">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("rename", { name: view.name })}
                    onClick={() => setDialog({ kind: "rename", view })}
                  >
                    {t("renameAction")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("share", { name: view.name })}
                    onClick={() => setDialog({ kind: "share", view })}
                  >
                    {t("shareAction")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("delete", { name: view.name })}
                    onClick={() => setDialog({ kind: "delete", view })}
                  >
                    {t("deleteAction")}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-24">
      <div aria-live="polite" className="flex flex-col gap-8">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {status && !error ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {status}
          </p>
        ) : null}
      </div>
      {section("saved-views-mine", t("mine"), mine, t("mineEmpty"))}
      {section("saved-views-shared", t("shared"), shared, t("sharedEmpty"))}
      {dialog?.kind === "rename" ? (
        <RenameDialog
          view={dialog.view}
          onClose={() => setDialog(null)}
          onRename={(name) =>
            run(() => renameViewAction(org, dialog.view.id, name), t("renamed", { name }))
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
              v("status.shared", { name: dialog.view.name }),
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
          title={v("delete.title", { name: dialog.view.name })}
          description={v("delete.description")}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>{v("delete.cancel")}</Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const done = await run(
                    () => deleteViewAction(org, dialog.view.id),
                    v("status.deleted", { name: dialog.view.name }),
                  );
                  if (done) setDialog(null);
                }}
              >
                {v("delete.submit")}
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

function RenameDialog({
  view,
  onClose,
  onRename,
}: {
  view: SavedView;
  onClose: () => void;
  onRename: (name: string) => Promise<boolean>;
}) {
  const t = useTranslations("savedViews") as unknown as Translate;
  const formId = useId();
  const [name, setName] = useState(view.name);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("renameTitle", { name: view.name })}
      actions={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            {t("renameSubmit")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() === "") {
            setMissing(true);
            return;
          }
          setBusy(true);
          const done = await onRename(name.trim());
          setBusy(false);
          if (done) onClose();
        }}
      >
        <Input
          label={t("renameLabel")}
          value={name}
          maxLength={100}
          help={t("renameHelp")}
          {...(missing ? { error: t("renameRequired") } : {})}
          onChange={(e) => {
            setName(e.target.value);
            setMissing(false);
          }}
          autoFocus
        />
      </form>
    </Dialog>
  );
}
