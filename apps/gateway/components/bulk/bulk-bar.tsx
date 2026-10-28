"use client";

import type { BulkOutcome, BulkRow } from "@xos/data/bulk";
import { BulkActionBar, Button, Dialog, InlineAlert } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { notify } from "@/components/undo/notices";
import { gatewayBulkAction } from "@/lib/actions/bulk";
import {
  actionRows,
  eligibleIds,
  GATEWAY_ACTIONS,
  redoRows,
  refusalKey,
  type GatewayAction,
  type GatewayActionId,
} from "@/lib/bulk/catalog";
import type { BulkRowRef } from "./use-bulk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The bulk bar and its dialog for a Gateway collection (Section 11.7, ADR 0082), loaded with the
 * first selection. The action applies to the selected rows it fits (documents waiting for a
 * signature, drafted timesheets, open applications); the dialog previews it first, names any row
 * that cannot take it and why, and applies it in one transaction, so a refused row means nothing
 * changed. A submit goes on the undo stack (Undo recalls the timesheets, redo submits them again);
 * a signature or a withdrawal is final, so the dialog says so before it is applied.
 */
export function BulkBar({
  action: actionId,
  rows,
  selected,
  open,
  onOpen,
  onClose,
  onClear,
}: {
  action: GatewayActionId;
  rows: readonly BulkRowRef[];
  selected: ReadonlySet<string>;
  /** Whether the dialog is open; a row's menu opens it too. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("gateway.collections") as unknown as Translate;
  const outcomes = useTranslations("gateway.outcomes") as unknown as Translate;
  const router = useRouter();
  const action = GATEWAY_ACTIONS[actionId];
  const labels = new Map(rows.map((r) => [r.id, r.label]));
  const ids = eligibleIds(rows, selected);

  /** A refused row's sentence, with the row's name when the page still shows it. */
  const refusal = (first: BulkOutcome["refused"][number] | undefined): string => {
    if (!first) return t("failed");
    const message = t(refusalKey(first.rule));
    const row = first.id ? labels.get(first.id) : undefined;
    return row ? t("refusedRow", { row, message }) : message;
  };

  /** Sends rows back through the RPC for an undo or a redo; the stack reports the outcome. */
  const send = async (batch: readonly BulkRow[]): Promise<UndoResult> => {
    const result = await gatewayBulkAction({
      resource: action.resource,
      rows: batch.map((r) => ({
        id: r.id,
        set: stringValues(r.set),
        ...(r.expect ? { expect: stringValues(r.expect) } : {}),
      })),
      preview: false,
    });
    if (result.ok && result.outcome.committed) {
      router.refresh();
      return { ok: true };
    }
    return {
      ok: false,
      message: result.ok ? refusal(result.outcome.refused[0]) : outcomes(result.outcome),
    };
  };

  return (
    <>
      {selected.size > 0 ? (
        <div className="pointer-events-none sticky bottom-16 z-sticky flex justify-center print:hidden">
          <div className="pointer-events-auto">
            <BulkActionBar
              count={selected.size}
              announce={false}
              actions={[
                {
                  label: t(`actions.${action.id}.bulk`, { count: ids.length }),
                  icon: action.icon,
                  onSelect: onOpen,
                },
              ]}
              onClear={onClear}
            />
          </div>
        </div>
      ) : null}
      {open && selected.size > 0 ? (
        <BulkDialog
          action={action}
          ids={ids}
          skipped={selected.size - ids.length}
          t={t}
          outcomes={outcomes}
          refusal={refusal}
          onClose={onClose}
          onDone={(outcome) => {
            onClose();
            onClear();
            const label = t(`actions.${action.id}.done`, { count: outcome.changed });
            if (action.undoable && outcome.inverse.length > 0) {
              const inverse = outcome.inverse;
              undoStack.push({
                label,
                undo: () => send(inverse),
                redo: () => send(redoRows(inverse)),
              });
            } else {
              notify(label);
            }
          }}
        />
      ) : null}
    </>
  );
}

/** Bulk values on the wire are strings or null, the states these actions set. */
function stringValues(values: Readonly<Record<string, unknown>>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value === null || value === undefined ? null : String(value);
  }
  return out;
}

function BulkDialog({
  action,
  ids,
  skipped,
  t,
  outcomes,
  refusal,
  onClose,
  onDone,
}: {
  action: GatewayAction;
  ids: readonly string[];
  /** Selected rows the action does not fit, left out of it. */
  skipped: number;
  t: Translate;
  outcomes: Translate;
  refusal: (first: BulkOutcome["refused"][number] | undefined) => string;
  onClose: () => void;
  onDone: (outcome: BulkOutcome) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (asPreview: boolean) =>
    start(async () => {
      const result = await gatewayBulkAction({
        resource: action.resource,
        rows: actionRows(action, ids).map((r) => ({ id: r.id, set: stringValues(r.set) })),
        preview: asPreview,
      });
      if (!result.ok) {
        setError(outcomes(result.outcome));
        return;
      }
      setError(null);
      if (!asPreview && result.outcome.committed) {
        router.refresh();
        onDone(result.outcome);
        return;
      }
      setPreview(result.outcome);
    });

  // The preview runs as the dialog opens. Applying sends the rows selected then, and a row that can
  // no longer take the action by that time comes back refused, with nothing changed.
  useEffect(() => {
    if (ids.length > 0) run(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the dialog opens
  }, []);

  const count = ids.length;
  const blocked = preview !== null && preview.refused.length > 0;
  const nothing = count === 0 || (preview !== null && !blocked && preview.changed === 0);
  return (
    <Dialog
      open
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={t(`actions.${action.id}.title`, { count })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={preview === null || blocked || nothing}
            onClick={() => run(false)}
          >
            {t(`actions.${action.id}.apply`, { count: preview?.changed ?? count })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12 text-text-primary">
        {skipped > 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t(`actions.${action.id}.skipped`, { count: skipped })}
          </p>
        ) : null}
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {count === 0 ? (
          <p className="m-0 text-text-13">{t(`actions.${action.id}.none`)}</p>
        ) : preview === null ? (
          <p className="m-0 text-text-13 text-text-secondary" role="status">
            {t("checking")}
          </p>
        ) : blocked ? (
          <InlineAlert tone="warning" title={t("refusedTitle", { count: preview.refused.length })}>
            <p className="m-0 mb-6">{t("refusedBody")}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {preview.refused.map((r, i) => (
                <li key={r.id ?? i}>{refusal(r)}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : (
          <div role="status" className="flex flex-col gap-4 text-text-13">
            {preview.changed === 0 ? (
              <p className="m-0">{t(`actions.${action.id}.nothing`)}</p>
            ) : (
              <p className="m-0 font-medium">
                {t(`actions.${action.id}.willChange`, { count: preview.changed })}
              </p>
            )}
            {preview.unchanged > 0 ? (
              <p className="m-0 text-text-secondary">
                {t(`actions.${action.id}.unchanged`, { count: preview.unchanged })}
              </p>
            ) : null}
          </div>
        )}
        {count > 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t(action.undoable ? `actions.${action.id}.undoable` : `actions.${action.id}.final`)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
