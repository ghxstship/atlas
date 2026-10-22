"use client";

import { Button } from "@xos/ui";
import { useActionState, useEffect, useRef } from "react";
import { exportForm1099Action, type ActionState } from "@/app/[org]/finance/actions";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";
import { INITIAL } from "./forms.shared";

const stepUpRefused = (state: ActionState) =>
  state.error?.kind === "refusal" && state.error.rule === "step_up_required";

/**
 * Downloads the 1099-NEC file of a tax year. Its full TINs make it a Restricted export: the database asks for a
 * second factor passed in the last 15 minutes, and the step-up dialog gets one and downloads (A38-006, A77).
 */
export function Form1099ExportForm({ org, year }: { org: string; year: number }) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(exportForm1099Action, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const stepUpDialog = useStepUpForm(state, stepUpRefused, form);
  useEffect(() => {
    if (!state.csv || !state.filename) return;
    const url = URL.createObjectURL(new Blob([state.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = state.filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [state.at, state.csv, state.filename]);
  // The dialog renders outside the form: React bubbles a portal's submit event to its tree parents.
  return (
    <>
      {stepUpDialog}
      <form
        ref={form}
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
    </>
  );
}
