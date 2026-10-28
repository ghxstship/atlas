"use client";

import { toCsv } from "@xos/data/finance";
import { emitWorkflow } from "@xos/data/workflow-signal";
import {
  Button,
  CoordinateMatrix,
  Input,
  Select,
  type DepartmentCode,
  type PhaseCode,
} from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { revokeShareAction, runReportAction, shareReportAction } from "@/app/[org]/reports/actions";
import { ActionFeedback } from "@/components/finance/kit-action-feedback";
import { InlineActionButton } from "@/components/finance/kit-inline-action-button";
import { fieldError } from "@/components/finance/kit-field-error";
import { useFinanceT } from "@/components/finance/kit-use-finance-t";
import { useNamespaceT } from "@/components/finance/kit-use-namespace-t";
import { type Option } from "@/components/finance/kit.types";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * Client parts of the Reports pages (A15): CSV export of what a report shows (Section 4.6.4: every
 * report exports), the coordinate matrix with drill-through, and the saved report run and share forms.
 */

export function ExportCsvButton({
  filename,
  header,
  rows,
  label,
}: {
  filename: string;
  header: readonly string[];
  rows: readonly (readonly string[])[];
  label: string;
}) {
  return (
    <Button
      icon="Download"
      onClick={() => {
        const url = URL.createObjectURL(
          new Blob([toCsv(header, rows)], { type: "text/csv;charset=utf-8" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      {label}
    </Button>
  );
}

/** The 10 by 9 coordinate matrix; choosing a cell opens the records behind it. */
export function MatrixWithDrill({
  label,
  corner,
  rows,
  cols,
  cells,
  hrefFor,
}: {
  label: string;
  corner: string;
  rows: { code: DepartmentCode; name: string }[];
  cols: { gate: number; code: PhaseCode; name: string }[];
  cells: Record<string, number>;
  hrefFor: Record<string, string>;
}) {
  const router = useRouter();
  return (
    <CoordinateMatrix
      label={label}
      corner={corner}
      rows={rows}
      cols={cols}
      cells={cells}
      onCellSelect={(dept: string, phase: string) => {
        const href = hrefFor[`${dept}|${phase}`];
        if (!href) return;
        emitWorkflow("atlas.reports:done");
        router.push(href as Route);
      }}
    />
  );
}

export function RunReportForm({
  org,
  reportDefinitionId,
}: {
  org: string;
  reportDefinitionId: string;
}) {
  const t = useNamespaceT("reports");
  const [state, action, pending] = useActionState(runReportAction, {});
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-wrap items-end gap-8"
      aria-label={t("run")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="reportDefinitionId" value={reportDefinitionId} />
      <Select
        id={`run-format-${reportDefinitionId}`}
        name="format"
        label={t("format")}
        value="PDF"
        options={["PDF", "CSV", "XLSX"].map((f) => ({ value: f, label: f }))}
      />
      <Button type="submit" loading={pending}>
        {t("run")}
      </Button>
      <ActionFeedback state={state} success={t("runQueued")} />
    </form>
  );
}

export function ShareReportForm({
  org,
  reportRunId,
  title,
  engagements,
}: {
  org: string;
  reportRunId: string;
  title: string;
  engagements: readonly Option[];
}) {
  const t = useNamespaceT("reports");
  const f = useFinanceT();
  const [state, action, pending] = useActionState(shareReportAction, {});
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8"
      aria-label={t("share")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="reportRunId" value={reportRunId} />
      <div className="flex flex-wrap items-end gap-8">
        <Select
          id={`share-engagement-${reportRunId}`}
          name="engagementId"
          label={t("shareWith")}
          placeholder={f("settlements.fields.chooseEngagement")}
          options={[...engagements]}
          error={fieldError(f, state, "engagementId")}
        />
        <Input
          id={`share-title-${reportRunId}`}
          name="title"
          label={t("shareTitle")}
          defaultValue={title}
          error={fieldError(f, state, "title")}
        />
        <Input
          id={`share-expires-${reportRunId}`}
          name="expiresAt"
          type="date"
          label={t("shareExpires")}
          error={fieldError(f, state, "expiresAt")}
        />
        <Button type="submit" loading={pending}>
          {t("share")}
        </Button>
      </div>
      <ActionFeedback state={state} success={t("shared")} />
    </form>
  );
}

export function RevokeShareButton({ org, id }: { org: string; id: string }) {
  const t = useNamespaceT("reports");
  return (
    <InlineActionButton
      action={revokeShareAction}
      fields={{ org, id }}
      label={t("revoke")}
      variant="danger"
      icon="X"
    />
  );
}
