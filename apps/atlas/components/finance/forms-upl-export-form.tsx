"use client";

import { Button, Select } from "@xos/ui";
import { useActionState, useEffect } from "react";
import { exportUplAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL } from "./forms.shared";

/** Builds the export on the server and hands the browser the CSV file to save. */
export function UplExportForm({
  org,
  from,
  to,
  projectId,
  targets,
}: {
  org: string;
  from: string;
  to: string;
  projectId: string | null;
  targets: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(exportUplAction, INITIAL);
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
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-wrap items-end gap-12"
      noValidate
      aria-label={t("upl.export")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
      <Select
        id="upl-target"
        name="target"
        label={t("upl.target")}
        value="upl"
        options={[{ value: "upl", label: t("upl.targets.upl") }, ...targets]}
        error={fieldError(t, state, "target")}
      />
      <Button type="submit" variant="primary" icon="Download" loading={pending}>
        {t("upl.export")}
      </Button>
      <ActionFeedback
        state={state}
        {...(state.filename ? { success: t("upl.exported", { file: state.filename }) } : {})}
      />
    </form>
  );
}
