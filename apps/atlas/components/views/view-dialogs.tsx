"use client";

import type { SavedView, Team } from "@xos/data/views";
import { Button, Checkbox, Dialog, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

/** Copy lookups take built keys (`status.saved`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The dialog the view switcher has open. */
export type ViewDialogState =
  | { readonly kind: "save"; readonly name?: string }
  | { readonly kind: "share"; readonly view: SavedView }
  | { readonly kind: "delete"; readonly view: SavedView };

/**
 * The saved-view dialogs of the collection view switcher (collection-views.tsx): save the current
 * view, share one, or delete one. They load the first time one opens (A24-009).
 */
export function ViewDialog({
  dialog,
  teams,
  onClose,
  onSave,
  onShare,
  onDelete,
}: {
  dialog: ViewDialogState;
  teams: readonly Team[];
  onClose: () => void;
  onSave: (name: string, share: Share) => Promise<boolean>;
  onShare: (view: SavedView, share: Share) => Promise<boolean>;
  onDelete: (view: SavedView) => Promise<void>;
}) {
  const t = useTranslations("views") as unknown as Translate;
  if (dialog.kind === "save") {
    return <SaveDialog name={dialog.name} teams={teams} onClose={onClose} onSave={onSave} />;
  }
  if (dialog.kind === "share") {
    return (
      <ShareDialog
        view={dialog.view}
        teams={teams}
        onClose={onClose}
        onShare={(share) => onShare(dialog.view, share)}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("delete.title", { name: dialog.view.name })}
      description={t("delete.description")}
      actions={
        <>
          <Button onClick={onClose}>{t("delete.cancel")}</Button>
          <Button variant="danger" onClick={() => void onDelete(dialog.view)}>
            {t("delete.submit")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

export interface Share {
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
  name: initial = "",
  teams,
  onClose,
  onSave,
}: {
  /** The name it starts with: a built-in view's, when saving a copy of one. */
  name?: string | undefined;
  teams: readonly Team[];
  onClose: () => void;
  onSave: (name: string, share: Share) => Promise<boolean>;
}) {
  const t = useTranslations("views.save") as unknown as Translate;
  const formId = useId();
  const [name, setName] = useState(initial);
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

// The view switcher's writes load with these dialogs, so their server references stay off every
// collection's first load (A24-009).
export {
  deleteViewAction,
  saveViewAction,
  setDefaultViewAction,
  shareViewAction,
  updateViewAction,
} from "@/lib/views/actions";
