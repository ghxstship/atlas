"use client";

import { Button } from "@xos/ui";
import { useActionState, useEffect } from "react";
import { exportForm1099Action } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";
import { INITIAL } from "./forms.shared";

/** Downloads the 1099-NEC file of a tax year; the database asks for step-up first (A38-006). */
export function Form1099ExportForm({ org, year }: { org: string; year: number }) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(exportForm1099Action, INITIAL);
  useEffect(() => {
    if (!state.csv || !state.filename) return;
    const url = URL.createObjectURL(new Blob([state.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = state.filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [state.at, state.csv, state.filename]);
  return (
    <form
      action={action}
      className="flex flex-col gap-8"
      noValidate
      aria-label={t("yearEnd.export")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="year" value={year} />
      <p className="m-0 text-text-13 text-text-secondary">{t("yearEnd.exportSentence")}</p>
      <div>
        <Button type="submit" variant="primary" icon="Download" loading={pending}>
          {t("yearEnd.export")}
        </Button>
      </div>
      <ActionFeedback
        state={state}
        {...(state.filename ? { success: t("yearEnd.exported", { file: state.filename }) } : {})}
      />
    </form>
  );
}
