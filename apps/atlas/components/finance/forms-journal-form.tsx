"use client";

import { Button, Input, Select } from "@xos/ui";
import { useActionState, useState } from "react";
import { createJournalEntryAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";
import { type DraftLine } from "./forms.types";

export function JournalForm({
  org,
  periods,
  projects,
  projectId,
  accounts,
  costCenters,
  currencies,
  defaultCurrency,
  today,
}: {
  org: string;
  periods: readonly Option[];
  projects: readonly Option[];
  projectId: string | null;
  accounts: readonly Option[];
  costCenters: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(createJournalEntryAction, INITIAL);
  useAfterSave(state, "create");
  const blank = (key: number): DraftLine => ({
    key,
    accountCode: accounts[0]?.value ?? "",
    costCenterId: "",
    urid: "",
    description: "",
    debit: "",
    credit: "",
  });
  const [lines, setLines] = useState<DraftLine[]>([blank(1), blank(2)]);
  const set = (key: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const payload = JSON.stringify(
    lines.map((l) => ({
      accountCode: l.accountCode,
      costCenterId: l.costCenterId || null,
      urid: l.urid.trim() || null,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="lines" value={payload} />
      <Select
        id="journal-period"
        name="periodId"
        label={t("journal.fields.period")}
        placeholder={t("journal.fields.choosePeriod")}
        options={[...periods]}
        error={fieldError(t, state, "periodId")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="journal-date"
          name="entryDate"
          type="date"
          required
          label={t("journal.fields.entryDate")}
          defaultValue={today}
          error={fieldError(t, state, "entryDate")}
        />
        <Select
          id="journal-currency"
          name="currency"
          label={t("common.currency")}
          value={defaultCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
        />
      </div>
      <Input
        id="journal-memo"
        name="memo"
        required
        width="100%"
        label={t("journal.fields.memo")}
        error={fieldError(t, state, "memo")}
      />
      {projectId ? (
        <input type="hidden" name="projectId" value={projectId} />
      ) : (
        <Select
          id="journal-project"
          name="projectId"
          label={t("common.project")}
          value=""
          options={[{ value: "", label: t("common.none") }, ...projects]}
        />
      )}
      <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
        <legend className="mb-8 text-label-13 font-semibold">{t("journal.fields.lines")}</legend>
        {lines.map((l, i) => (
          <div
            key={l.key}
            className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
          >
            <div className="flex flex-wrap gap-8">
              <Select
                id={`jl-account-${l.key}`}
                label={t("journal.fields.account", { n: i + 1 })}
                value={l.accountCode}
                options={[...accounts]}
                onChange={(e) => set(l.key, { accountCode: e.target.value })}
              />
              <Select
                id={`jl-cc-${l.key}`}
                label={t("budgets.columns.costCenter")}
                value=""
                options={[{ value: "", label: t("common.none") }, ...costCenters]}
                onChange={(e) => set(l.key, { costCenterId: e.target.value })}
              />
              <Input
                id={`jl-urid-${l.key}`}
                width={140}
                label={t("budgets.columns.urid")}
                value={l.urid}
                onChange={(e) => set(l.key, { urid: e.target.value })}
              />
            </div>
            <Input
              id={`jl-desc-${l.key}`}
              width="100%"
              label={t("common.description")}
              value={l.description}
              onChange={(e) => set(l.key, { description: e.target.value })}
            />
            <div className="flex flex-wrap items-end gap-8">
              <Input
                id={`jl-debit-${l.key}`}
                width={140}
                inputMode="decimal"
                label={t("journal.fields.debit")}
                value={l.debit}
                onChange={(e) => set(l.key, { debit: e.target.value })}
              />
              <Input
                id={`jl-credit-${l.key}`}
                width={140}
                inputMode="decimal"
                label={t("journal.fields.credit")}
                value={l.credit}
                onChange={(e) => set(l.key, { credit: e.target.value })}
              />
              {lines.length > 2 ? (
                <Button
                  variant="ghost"
                  icon="Trash2"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  {t("journal.removeLine")}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        <div>
          <Button
            icon="Plus"
            onClick={() => setLines((ls) => [...ls, blank(Math.max(...ls.map((x) => x.key)) + 1)])}
          >
            {t("journal.addLine")}
          </Button>
        </div>
        {state.fieldErrors?.["lines"] ? (
          <p role="alert" className="m-0 text-text-13 text-danger-text">
            {fieldError(t, state, "lines")}
          </p>
        ) : null}
      </fieldset>
      <ActionFeedback state={state} />
      <Submit label={t("journal.create")} pending={pending} />
    </form>
  );
}
