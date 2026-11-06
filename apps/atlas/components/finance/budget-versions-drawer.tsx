"use client";

import { useFormatter } from "next-intl";
import type { BudgetVersion } from "@xos/data/budget-versions";
import { Button, Drawer, Input, ToastRegion, UndoToast } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import {
  deleteBudgetVersionAction,
  loadBudgetVersionsAction,
  restoreBudgetVersionAction,
  takeSnapshotAction,
} from "@/app/[org]/finance/quote-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";

/**
 * Versions of a budget (G-210, ADR 0152): captures with who took them and when, Take snapshot and
 * Compare. Only a Snapshot goes to Trash, with Undo; a Quote capture backs a sent quote and stays.
 * Compare opens on the budgets page in place of the grid, so a link to it can be shared.
 */
export function BudgetVersionsDrawer({
  org,
  budgetId,
  canWrite,
  onClose,
}: {
  org: string;
  budgetId: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const t = useFinanceT();
  const format = useFormatter();
  const go = useQueryNav();
  const router = useRouter();
  const [versions, setVersions] = useState<readonly BudgetVersion[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, snapshot, snapshotting] = useActionState(takeSnapshotAction, {});
  const [undo, setUndo] = useState<string | null>(null);
  const [, start] = useTransition();

  const load = () =>
    start(async () => {
      const result = await loadBudgetVersionsAction(org, budgetId);
      if (result.ok) setVersions(result.versions);
      else setLoadFailed(true);
    });
  // Loads when the drawer opens and after each snapshot this drawer takes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [budgetId, state.at]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={t("budgets.versions.title")}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      <div className="flex flex-col gap-16">
        <p className="m-0 text-text-13 text-text-secondary">{t("budgets.versions.sentence")}</p>
        {canWrite ? (
          <form
            action={snapshot}
            onSubmit={keepInputOnSubmit(snapshot)}
            className="flex flex-wrap items-end gap-8"
          >
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="budgetId" value={budgetId} />
            <Input
              id="snapshot-label"
              name="label"
              required
              label={t("budgets.versions.label")}
              error={fieldError(t, state, "label")}
            />
            <Button type="submit" loading={snapshotting}>
              {t("budgets.versions.take")}
            </Button>
          </form>
        ) : null}
        <ActionFeedback state={state} />
        {loadFailed ? (
          <p role="alert" className="m-0 text-text-13 text-danger-text">
            {t("budgets.versions.loadError")}
          </p>
        ) : null}
        {versions && versions.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("budgets.versions.empty")}</p>
        ) : null}
        {versions && versions.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex min-w-0 flex-col">
                  <span className="text-text-13 text-text-primary">
                    <span className="font-mono text-text-12 text-text-secondary">
                      {v.versionNumber}
                    </span>{" "}
                    {v.label}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`budgets.versions.purposes.${v.purpose}`)}
                    {v.createdByName ? ` · ${v.createdByName}` : ""}
                    {" · "}
                    {format.dateTime(new Date(v.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </span>
                <span className="flex gap-8">
                  <Button
                    size="sm"
                    onClick={() => {
                      onClose();
                      go({ budget: budgetId, compare: v.id, to: "live" });
                    }}
                  >
                    {t("budgets.versions.compare")}
                  </Button>
                  {canWrite && v.purpose === "Snapshot" ? (
                    <Button
                      size="sm"
                      icon="Trash2"
                      onClick={() =>
                        start(async () => {
                          const result = await deleteBudgetVersionAction(org, v.id);
                          if (result.ok) {
                            setVersions((list) => list?.filter((x) => x.id !== v.id) ?? null);
                            setUndo(v.id);
                          }
                        })
                      }
                    >
                      {t("common.delete")}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <ToastRegion label={t("common.notifications")}>
        {undo ? (
          <UndoToast
            key={undo}
            message={t("budgets.versions.deleted")}
            onUndo={() => {
              const id = undo;
              setUndo(null);
              start(async () => {
                await restoreBudgetVersionAction(org, id);
                load();
                router.refresh();
              });
            }}
            onExpire={() => setUndo(null)}
          />
        ) : null}
      </ToastRegion>
    </Drawer>
  );
}
