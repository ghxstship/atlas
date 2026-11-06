"use client";

import type { BudgetLine, BudgetLineInput } from "@xos/data/finance";
import { Button, Dialog, MultiSelect } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateBudgetLineAction, type ActionState } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";

function inputOf(line: BudgetLine, excludedFromQuote: boolean): BudgetLineInput {
  return {
    description: line.description,
    lineType: line.lineType,
    urid: line.urid,
    costCenterId: line.costCenterId,
    gradeCode: line.gradeCode,
    elementId: line.elementId,
    quantity: line.quantity,
    unitBasis: line.unitBasis,
    unitPriceMinor: line.unitPriceMinor,
    xyz: line.xyz,
    xyzBasis: line.xyzBasis,
    markupBp: line.markupBp,
    clientUnitPriceMinor: line.clientUnitPriceMinor,
    excludedFromQuote,
    etcMinor: line.etcMinor,
  };
}

/**
 * Which lines go on a quote (G-188): internal lines such as contingency stay off. Saves only the lines
 * that changed, each against the version it was read at; a line someone else saved first keeps their
 * value and the status says so, as the grid's own saves do.
 */
export function QuoteLinesDialog({
  org,
  lines,
  onClose,
}: {
  org: string;
  lines: readonly BudgetLine[];
  onClose: () => void;
}) {
  const t = useFinanceT();
  const router = useRouter();
  const [onQuote, setOnQuote] = useState<string[]>(
    lines.filter((l) => !l.excludedFromQuote).map((l) => l.id),
  );
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const wanted = new Set(onQuote);
      let last: ActionState = { ok: true };
      for (const line of lines) {
        const excluded = !wanted.has(line.id);
        if (excluded === line.excludedFromQuote) continue;
        const form = new FormData();
        form.set("org", org);
        form.set("id", line.id);
        form.set("expectedUpdatedAt", line.updatedAt);
        form.set("line", JSON.stringify(inputOf(line, excluded)));
        last = await updateBudgetLineAction({}, form);
        if (!last.ok) break;
      }
      setState(last);
      router.refresh();
      if (last.ok) onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? null : onClose())}
      title={t("budgets.quoteLines")}
      description={t("budgets.quoteLinesSentence")}
      actions={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={pending} onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <MultiSelect
        id="quote-lines"
        label={t("budgets.columns.onQuote")}
        value={onQuote}
        options={lines.map((l) => ({
          value: l.id,
          label: `${l.lineNumber} · ${l.description}`,
        }))}
        onChange={setOnQuote}
      />
      {state.error?.kind === "conflict" ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {t("budgets.quoteLinesConflict")}
        </p>
      ) : (
        <ActionFeedback state={state} />
      )}
    </Dialog>
  );
}
